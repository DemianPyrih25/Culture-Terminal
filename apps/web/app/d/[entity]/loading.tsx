import { DesChrome } from "@/components/des/des-chrome";
import { ReferenceGrid } from "@/components/method/reference";
import { BriefRow } from "@/components/layout/brief-row";
import { MetaLine } from "@/components/ui/meta-line";

/**
 * While a tearsheet is computed (a few seconds when its requests are not cached): the page head with
 * what is being read, and placeholder rules where the key figures go.
 */
export default function DesLoading() {
  return (
    <DesChrome>
      <ReferenceGrid outline={null}>
        <BriefRow>
          <div className="flex flex-col gap-[22px]" role="status" aria-live="polite" data-des-loading="true">
            <MetaLine desk="DES" job="Tearsheet" extra={["Computing in code · $0 LLM"]} />
            <div className="flex flex-col gap-2">
              <p className="m-0 font-serif text-[32px] leading-[38px] font-medium text-dim md:text-[40px] md:leading-[48px]">Reading Qloo…</p>
              <p className="m-0 font-serif text-[18px] leading-[27px] text-text-2">
                Matching the name exactly, then Audience DNA, cultural neighbours and travel taste: usually eight Qloo requests, each
                one listed in Receipts.
              </p>
            </div>
            <div aria-hidden="true" className="flex gap-8 pt-2">
              {[0, 1, 2, 3].map((i) => (
                <div key={i} className="flex flex-col gap-2">
                  <span className="h-px w-[72px] bg-line-strong" />
                  <span className="h-px w-11 bg-line-strong" />
                </div>
              ))}
            </div>
          </div>
        </BriefRow>
      </ReferenceGrid>
    </DesChrome>
  );
}
