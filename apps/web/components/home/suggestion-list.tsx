import type { MouseEvent } from "react";
import { cx } from "../ui/cx";
import { Icon } from "../ui/icons";
import { Tag } from "../ui/tag";
import { PLACE_HINT, type Suggestion, type SuggestionGroup } from "./suggestions";

export interface SuggestionListProps {
  /** The listbox id, which the field's aria-controls names. */
  id: string;
  groups: readonly SuggestionGroup[];
  /** The key of the active row, or null. */
  activeKey: string | null;
  onPick: (row: Suggestion) => void;
  /** Hovering a row makes it the active one. */
  onHover?: (row: Suggestion) => void;
  className?: string;
}

/** A row's element id: the field's aria-activedescendant. */
export function suggestionOptionId(listId: string, key: string): string {
  return `${listId}-${key}`;
}

/**
 * SuggestionList: an overlay under the box, small radius on a hairline, grouped rows of 44 and the hint
 * bar about place questions. A listbox of options; the field keeps focus and walks it with the arrows.
 * A row press is taken on mouse down, so the field's blur does not close the list first.
 */
export function SuggestionList({ id, groups, activeKey, onPick, onHover, className }: SuggestionListProps) {
  return (
    <div className={cx("overflow-hidden rounded-md border border-line-strong bg-surface shadow-md", className)}>
      <div id={id} role="listbox" aria-label="Suggestions" className="flex flex-col p-2">
        {groups.map((group) => {
          const labelId = `${id}-${group.key}-label`;
          return (
            <div key={group.key} role="group" aria-labelledby={labelId} className="flex flex-col">
              <div id={labelId} role="presentation" className="flex h-7 items-center px-3 text-[11px] leading-4 font-semibold tracking-[0.08em] text-ink-3 uppercase">
                {group.label}
              </div>
              {group.rows.map((row) => {
                const active = row.key === activeKey;
                return (
                  <div
                    key={row.key}
                    id={suggestionOptionId(id, row.key)}
                    role="option"
                    aria-selected={active}
                    onMouseDown={(event: MouseEvent) => {
                      event.preventDefault();
                      onPick(row);
                    }}
                    onMouseEnter={() => onHover?.(row)}
                    className={cx(
                      "flex h-11 cursor-pointer items-center gap-3 rounded-sm px-3 transition-colors duration-150",
                      active ? "bg-sunken" : "hover:bg-sunken",
                    )}
                  >
                    <Icon name={group.icon} size={16} className="shrink-0 text-ink-2" />
                    <span className="min-w-0 flex-1 truncate type-body text-ink">{row.label}</span>
                    <Tag preset={row.tag} />
                  </div>
                );
              })}
            </div>
          );
        })}
      </div>
      <p className="m-0 flex min-h-9 items-center gap-2 border-t border-line bg-sunken px-4 py-2 type-caption text-ink-2">
        <Icon name="map-pin" size={14} className="shrink-0" />
        {PLACE_HINT}
      </p>
    </div>
  );
}
