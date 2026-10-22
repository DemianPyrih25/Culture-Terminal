import type { Metadata } from "next";
import { notFound } from "next/navigation";
import { RunViewer } from "@/components/run-viewer";
import { isRunId } from "@/lib/run-id";

// User runs are unlisted (D31).
export const metadata: Metadata = {
  title: "Run · Culture Terminal",
  robots: { index: false, follow: false },
};

export default async function RunPage(props: PageProps<"/run/[id]">) {
  const { id } = await props.params;
  if (!isRunId(id)) notFound();
  return <RunViewer key={id} runId={id} />;
}
