import type { ReactNode } from "react";
import { cx } from "../ui/cx";

// A BriefRow is plain markup; it reads the mobile tab from the BriefGrid it sits in (group/brief), so it
// stays a server component.

export interface BriefRowProps {
  /** Reading-column content. */
  children: ReactNode;
  /** This row's sidenotes, level with the row's first line at ≥1280 px. */
  notes?: ReactNode;
  id?: string;
  className?: string;
}

/**
 * One band of the brief: reading content and the sidenotes that sit level with it. At ≥1280 px the notes
 * take the sidenote column; below, they fold under the content; below 768 px they show only on the
 * Sources tab, and the content only on the Report tab.
 */
export function BriefRow({ children, notes, id, className }: BriefRowProps) {
  const hasNotes = notes !== undefined && notes !== null && notes !== false;
  return (
    <div
      id={id}
      className={cx(
        "min-w-0 xl:col-span-3 xl:grid xl:grid-cols-subgrid xl:items-start",
        // The Sources tab lists the notes alone: no row spacing meant for the paragraphs.
        "max-md:group-data-[tab=sources]/brief:py-0",
        !hasNotes && "max-md:group-data-[tab=sources]/brief:hidden",
        className,
      )}
    >
      <div className="min-w-0 max-w-[680px] xl:col-start-1 max-md:group-data-[tab=sources]/brief:hidden">
        {children}
      </div>
      {hasNotes ? (
        <div
          role="note"
          aria-label="Sidenotes"
          className="mt-4 max-w-[680px] border-t border-line pt-3 xl:col-start-3 xl:mt-0 xl:border-t-0 xl:pt-0 max-md:mt-0 max-md:border-t-0 max-md:pt-0 max-md:pb-4 max-md:group-data-[tab=report]/brief:hidden"
        >
          {notes}
        </div>
      ) : null}
    </div>
  );
}
