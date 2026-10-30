import "server-only";
import type { Lane } from "@ct/contracts";

/** A waiting run's place, as run.queued carries it: 1 = next to start on its lane. */
export interface QueuePlace {
  position: number;
  /** Runs of its lane waiting ahead of it (position − 1). */
  ahead: number;
  /** Whole seconds left before it gives up waiting. */
  waitSMax: number;
}

export interface QueueOptions<T> {
  /** Runs that may wait at once, reserved ones included; 0 turns the queue off. */
  max: number;
  /** How long a run waits for a slot before onTimeout. */
  waitMs: number;
  /** Told a waiting run's place when it enters and again whenever its position changes. */
  onPlace: (id: string, place: QueuePlace, value: T) => void;
  /** A run waited waitMs without a slot. It has already left the queue. */
  onTimeout: (id: string, value: T) => void;
}

/** A run taken out of the queue to start; `restore` puts it back. */
export interface TakenRun<T> {
  id: string;
  lane: Lane;
  value: T;
  order: number;
  deadline: number;
}

interface Entry<T> {
  id: string;
  lane: Lane;
  value: T;
  /** Join order: a run handed back after a failed start goes back to its old place. */
  order: number;
  /** False while its admission runs: it holds a place but has no position and cannot start yet. */
  entered: boolean;
  deadline: number;
  timer: ReturnType<typeof setTimeout> | null;
  /** The position it was last told; 0 before the first. */
  told: number;
}

/**
 * The global run queue (D24): runs that found every agent slot of their lane busy wait here, first in,
 * first out per lane, until a slot frees or waitMs runs out. A place is reserved before the run's
 * admission (so concurrent joins cannot pass `max`) and entered once the run's row exists. Nothing here
 * touches the database or the clock beyond timers: the run manager writes the events and the rows.
 */
export class RunQueue<T> {
  private readonly entries: Entry<T>[] = [];
  private joined = 0;

  constructor(private readonly options: QueueOptions<T>) {}

  /** Runs holding a place, reserved ones included. */
  get size(): number {
    return this.entries.length;
  }

  /** Runs waiting for a slot (entered), per lane or in all. */
  waiting(lane?: Lane): number {
    return this.entries.filter((e) => e.entered && (lane === undefined || e.lane === lane)).length;
  }

  has(id: string): boolean {
    return this.entries.some((e) => e.id === id);
  }

  get(id: string): T | null {
    return this.entries.find((e) => e.id === id)?.value ?? null;
  }

  values(): T[] {
    return this.entries.map((e) => e.value);
  }

  /** Holds a place for a run whose admission is about to run; false when the queue is full or off. */
  reserve(id: string, lane: Lane, value: T): boolean {
    if (this.entries.length >= this.options.max || this.has(id)) return false;
    this.entries.push({ id, lane, value, order: this.joined++, entered: false, deadline: 0, timer: null, told: 0 });
    return true;
  }

  /** The run's admission passed: its wait starts now and it is told its place. */
  enter(id: string): QueuePlace | null {
    const entry = this.entries.find((e) => e.id === id);
    if (!entry || entry.entered) return null;
    entry.entered = true;
    this.arm(entry, Date.now() + this.options.waitMs);
    this.announce();
    return this.placeOf(entry);
  }

  /** Takes a run out of the queue (a cancel, a refused admission, a shutdown). Null when it was not there. */
  leave(id: string): T | null {
    const i = this.entries.findIndex((e) => e.id === id);
    if (i === -1) return null;
    const [entry] = this.entries.splice(i, 1);
    this.disarm(entry!);
    this.announce();
    return entry!.value;
  }

  /**
   * The first waiting run whose lane `canStart` says has a free slot, taken out of the queue; null when
   * none can start. The runs behind it are told their new places.
   */
  take(canStart: (lane: Lane) => boolean): TakenRun<T> | null {
    const i = this.entries.findIndex((e) => e.entered && canStart(e.lane));
    if (i === -1) return null;
    const [entry] = this.entries.splice(i, 1);
    this.disarm(entry!);
    this.announce();
    return { id: entry!.id, lane: entry!.lane, value: entry!.value, order: entry!.order, deadline: entry!.deadline };
  }

  /**
   * Puts a taken run back at its old place with what was left of its wait, after a start that could
   * not go ahead yet; a run whose wait has run out times out at once. It held its place already, so
   * `max` does not apply: a join in between may leave the queue one over for a moment.
   */
  restore(taken: TakenRun<T>): boolean {
    if (this.has(taken.id)) return false;
    const entry: Entry<T> = {
      id: taken.id,
      lane: taken.lane,
      value: taken.value,
      order: taken.order,
      entered: true,
      deadline: taken.deadline,
      timer: null,
      told: 0,
    };
    const at = this.entries.findIndex((e) => e.order > entry.order);
    this.entries.splice(at === -1 ? this.entries.length : at, 0, entry);
    this.arm(entry, taken.deadline);
    this.announce();
    return true;
  }

  /** Empties the queue (shutdown): every run, reserved ones included, in join order. */
  clear(): { id: string; value: T }[] {
    const all = this.entries.splice(0, this.entries.length);
    for (const entry of all) this.disarm(entry);
    return all.map((e) => ({ id: e.id, value: e.value }));
  }

  /** The run's place now, or null when it is not waiting. */
  place(id: string): QueuePlace | null {
    const entry = this.entries.find((e) => e.id === id && e.entered);
    return entry ? this.placeOf(entry) : null;
  }

  private placeOf(entry: Entry<T>): QueuePlace {
    let ahead = 0;
    for (const e of this.entries) {
      if (e === entry) break;
      if (e.entered && e.lane === entry.lane) ahead += 1;
    }
    return { position: ahead + 1, ahead, waitSMax: Math.max(0, Math.ceil((entry.deadline - Date.now()) / 1000)) };
  }

  /** Tells every waiting run whose position changed (or that was never told) its place. */
  private announce(): void {
    for (const entry of this.entries) {
      if (!entry.entered) continue;
      const place = this.placeOf(entry);
      if (place.position === entry.told) continue;
      entry.told = place.position;
      this.options.onPlace(entry.id, place, entry.value);
    }
  }

  private arm(entry: Entry<T>, deadline: number): void {
    entry.deadline = deadline;
    entry.timer = setTimeout(() => this.expire(entry), Math.max(0, deadline - Date.now()));
  }

  private disarm(entry: Entry<T>): void {
    if (entry.timer !== null) clearTimeout(entry.timer);
    entry.timer = null;
  }

  private expire(entry: Entry<T>): void {
    const i = this.entries.indexOf(entry);
    if (i === -1) return;
    this.entries.splice(i, 1);
    entry.timer = null;
    this.options.onTimeout(entry.id, entry.value);
    this.announce();
  }
}
