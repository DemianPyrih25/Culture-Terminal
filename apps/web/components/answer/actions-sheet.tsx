"use client";

import Link from "next/link";
import { useEffect, useRef, useState } from "react";
import { Button, cx, Icon, IconButton, type IconName } from "../ui";

/**
 * The answer's actions on phones (redesign-v3 BPiz6): the page head's ellipsis opens a bottom sheet with
 * Share, Export, Copy link and Watch it being made, so every action of the desktop head stays reachable.
 * Follow keeps its own button beside the ellipsis (its menu needs the room). A native modal dialog: Esc,
 * the backdrop and Cancel close it.
 */
export function AnswerActionsSheet({
  question,
  replay,
  onShare,
}: {
  question: string;
  replay: string | null;
  onShare: () => void;
}) {
  const [open, setOpen] = useState(false);
  const ref = useRef<HTMLDialogElement>(null);
  useEffect(() => {
    const dialog = ref.current;
    if (!dialog) return;
    if (open && !dialog.open) {
      if (typeof dialog.showModal === "function") dialog.showModal();
      else dialog.setAttribute("open", "");
    } else if (!open && dialog.open) dialog.close();
  }, [open]);
  const close = () => setOpen(false);
  const row = "flex min-h-13 w-full items-center gap-3 border-t border-line px-1 py-3 text-left text-[16px] leading-6 font-medium text-ink";
  const item = (icon: IconName, label: string, run: () => void) => (
    <li>
      <button
        type="button"
        className={row}
        onClick={() => {
          close();
          run();
        }}
      >
        <Icon name={icon} size={18} className="shrink-0 text-ink-2" />
        {label}
      </button>
    </li>
  );
  return (
    <>
      <IconButton label="Answer actions" icon="ellipsis" aria-haspopup="dialog" aria-expanded={open} onClick={() => setOpen(true)} />
      <dialog
        ref={ref}
        aria-label="Answer actions"
        onClose={close}
        onCancel={(e) => {
          e.preventDefault();
          close();
        }}
        onClick={(e) => {
          if (e.target === e.currentTarget) close();
        }}
        className={cx(
          "mx-0 mt-auto mb-0 w-full max-w-none rounded-t-box border-t border-line bg-surface p-0 backdrop:bg-scrim",
          "max-h-[85vh]",
        )}
      >
        {open ? (
          <div className="flex flex-col gap-4 px-5 pt-3 pb-[max(20px,env(safe-area-inset-bottom))]">
            <span aria-hidden="true" className="mx-auto h-1 w-9 rounded-full bg-line-strong" />
            <div className="flex flex-col gap-1">
              <p className="text-[11px] leading-4 font-semibold tracking-[0.12em] text-ink-3 uppercase">This answer</p>
              <p className="line-clamp-2 type-body text-ink">{question}</p>
            </div>
            <ul className="flex flex-col border-b border-line">
              {item("share-2", "Share", onShare)}
              {item("download", "Export", () => window.print())}
              {item("link", "Copy link", onShare)}
              {replay ? (
                <li>
                  <Link href={replay} className={row} onClick={close}>
                    <Icon name="circle-play" size={18} className="shrink-0 text-ink-2" />
                    Watch it being made
                  </Link>
                </li>
              ) : null}
            </ul>
            <Button variant="secondary" size="lg" className="w-full" onClick={close}>
              Cancel
            </Button>
          </div>
        ) : null}
      </dialog>
    </>
  );
}
