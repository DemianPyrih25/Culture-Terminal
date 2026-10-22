// Runs once when a Next.js server process starts (not during `next build`).
export async function register(): Promise<void> {
  if (process.env.NEXT_RUNTIME !== "nodejs") return;
  if (process.env.NEXT_PHASE === "phase-production-build") return;
  const { startServer } = await import("./server/startup");
  await startServer();
}
