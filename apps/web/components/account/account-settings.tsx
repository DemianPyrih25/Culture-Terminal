"use client";

import { useState, type FormEvent, type ReactNode } from "react";
import { Button } from "../ui/button";
import { Input } from "../ui/fields";
import { SETTINGS_LABEL } from "../settings/settings-nav";
import { SignOutButton } from "./sign-out-button";

export interface AccountFacts {
  name: string;
  email: string;
  /** ISO time the account was made. */
  createdAt: string;
}

type Note = { tone: "good" | "bad"; text: string } | null;

function NoteLine({ note }: { note: Note }) {
  if (!note) return null;
  return (
    <p role="status" className={note.tone === "good" ? "type-caption animate-rise text-good-ink" : "type-caption animate-rise text-danger-ink"}>
      {note.text}
    </p>
  );
}

function Section({ title, order, children }: { title: string; order: number; children: ReactNode }) {
  return (
    <section className="animate-rise border-t border-line pt-6" style={{ animationDelay: `${order * 50}ms` }}>
      <h2 className={SETTINGS_LABEL}>{title}</h2>
      <div className="mt-4">{children}</div>
    </section>
  );
}

async function send(url: string, method: string, body: unknown): Promise<{ ok: boolean; error?: string; fields?: Record<string, string> }> {
  try {
    const res = await fetch(url, { method, headers: { "Content-Type": "application/json" }, body: JSON.stringify(body) });
    const data = (await res.json().catch(() => ({}))) as { error?: string; fields?: Record<string, string> };
    return { ok: res.ok, error: data.error, fields: data.fields };
  } catch {
    return { ok: false, error: "We could not reach Culture Terminal. Check your connection and try again." };
  }
}

/** /settings/account: profile name, the read-only email, a password change and sign out. */
export function AccountSettings({ account }: { account: AccountFacts }) {
  const [name, setName] = useState(account.name);
  const [savedName, setSavedName] = useState(account.name);
  const [nameBusy, setNameBusy] = useState(false);
  const [nameNote, setNameNote] = useState<Note>(null);
  const [nameError, setNameError] = useState<string | undefined>();

  const [current, setCurrent] = useState("");
  const [next, setNext] = useState("");
  const [pwBusy, setPwBusy] = useState(false);
  const [pwNote, setPwNote] = useState<Note>(null);
  const [pwFields, setPwFields] = useState<Record<string, string>>({});

  async function saveName(e: FormEvent<HTMLFormElement>) {
    e.preventDefault();
    setNameNote(null);
    const trimmed = name.trim();
    if (trimmed === "") return setNameError("Enter your name.");
    setNameError(undefined);
    setNameBusy(true);
    const r = await send("/api/auth/me", "PATCH", { name: trimmed });
    setNameBusy(false);
    if (r.ok) {
      setSavedName(trimmed);
      setName(trimmed);
      setNameNote({ tone: "good", text: "Name saved." });
    } else if (r.fields?.name) setNameError(r.fields.name);
    else setNameNote({ tone: "bad", text: r.error ?? "Could not save. Please try again." });
  }

  async function changePassword(e: FormEvent<HTMLFormElement>) {
    e.preventDefault();
    setPwNote(null);
    const local: Record<string, string> = {};
    if (current === "") local.currentPassword = "Enter your current password.";
    if (next.length < 10) local.newPassword = "Use at least 10 characters.";
    setPwFields(local);
    if (Object.keys(local).length > 0) return;
    setPwBusy(true);
    const r = await send("/api/auth/password", "POST", { currentPassword: current, newPassword: next });
    setPwBusy(false);
    if (r.ok) {
      setCurrent("");
      setNext("");
      setPwNote({ tone: "good", text: "Password changed. Other devices were signed out." });
    } else if (r.fields && Object.keys(r.fields).length > 0) setPwFields(r.fields);
    else setPwNote({ tone: "bad", text: r.error ?? "Could not change the password. Please try again." });
  }

  const joined = new Date(account.createdAt).toLocaleDateString("en-US", { year: "numeric", month: "long", day: "numeric" });

  return (
    <div className="flex flex-col gap-8" data-testid="account-settings">
      <header className="animate-rise">
        <h1 className="type-title-l text-ink">Account</h1>
        <p className="type-body mt-1 text-ink-2">{account.email} · since {joined}</p>
      </header>

      <Section title="Profile" order={1}>
        <form noValidate onSubmit={saveName} className="flex max-w-[440px] flex-col gap-4">
          <Input label="Name" name="name" autoComplete="name" maxLength={80} value={name} onChange={(e) => setName(e.target.value)} error={nameError} />
          <Input label="Email" name="email" value={account.email} readOnly disabled help="Cannot be changed yet." />
          <div className="flex items-center gap-3">
            <Button type="submit" variant="secondary" trailing={null} loading={nameBusy} disabled={nameBusy || name.trim() === savedName}>
              {nameBusy ? "Saving…" : "Save name"}
            </Button>
            <NoteLine note={nameNote} />
          </div>
        </form>
      </Section>

      <Section title="Password" order={2}>
        <form noValidate onSubmit={changePassword} className="flex max-w-[440px] flex-col gap-4">
          <Input
            label="Current password"
            name="currentPassword"
            type="password"
            autoComplete="current-password"
            value={current}
            onChange={(e) => setCurrent(e.target.value)}
            error={pwFields.currentPassword}
          />
          <Input
            label="New password"
            name="newPassword"
            type="password"
            autoComplete="new-password"
            value={next}
            onChange={(e) => setNext(e.target.value)}
            error={pwFields.newPassword}
            help="At least 10 characters."
          />
          <div className="flex items-center gap-3">
            <Button type="submit" variant="secondary" trailing={null} loading={pwBusy} disabled={pwBusy}>
              {pwBusy ? "Changing…" : "Change password"}
            </Button>
            <NoteLine note={pwNote} />
          </div>
        </form>
      </Section>

      <Section title="Session" order={3}>
        <div className="flex flex-wrap items-center justify-between gap-3">
          <p className="type-body text-ink-2">This device</p>
          <SignOutButton variant="secondary" />
        </div>
      </Section>
    </div>
  );
}
