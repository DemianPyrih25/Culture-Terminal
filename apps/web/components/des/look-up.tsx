"use client";

import { buttonClassName } from "../ui/button";
import { Icon } from "../ui/icons";
import { Popover } from "../ui/popover";
import type { DesType } from "./des-href";
import { DesSearch } from "./des-search";

/** Quiet "Look up another": a popover holding the profile search. */
export function LookUpAnother({ type }: { type: DesType }) {
  return (
    <Popover
      label="Look up a profile"
      placement="bottom-end"
      width={340}
      triggerClassName={buttonClassName("quiet", "md")}
      trigger={
        <>
          <Icon name="search" size={18} />
          <span>Look up another</span>
        </>
      }
    >
      <div className="flex flex-col gap-3">
        <p className="text-[15px] leading-6 font-semibold text-ink">Look up a profile</p>
        <DesSearch type={type} layout="stack" autoFocus />
      </div>
    </Popover>
  );
}
