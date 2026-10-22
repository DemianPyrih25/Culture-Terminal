// `pnpm db:migrate`: applies pending migrations, then exits. For local and manual use; the server
// also applies migrations itself on startup (RUN_MIGRATIONS), and there is no Railway pre-deploy step.
import { resolveDatabaseUrl, warnDefaultUrlOnce } from "./client";
import { loadRootEnv } from "./load-root-env";
import { migrateUrl, resolveMigrationsFolder } from "./migrate";

async function main(): Promise<void> {
  loadRootEnv();
  const { url, isDefault } = resolveDatabaseUrl();
  if (isDefault) warnDefaultUrlOnce();
  const folder = resolveMigrationsFolder();
  await migrateUrl(url, folder);
  process.stdout.write(`[@ct/db] migrations applied from ${folder}\n`);
}

function describe(err: unknown): string {
  // Unwrap Node's dual-stack AggregateError (empty message) and drizzle's DrizzleQueryError
  // (whose message is the whole SQL statement) down to the driver error that names the problem.
  let inner = err;
  for (let depth = 0; depth < 5; depth++) {
    if (inner instanceof AggregateError && inner.errors.length > 0) inner = inner.errors[0];
    else if (inner instanceof Error && inner.cause instanceof Error) inner = inner.cause;
    else break;
  }
  const message = inner instanceof Error ? inner.message : String(inner);
  const code = typeof inner === "object" && inner !== null && "code" in inner ? ` (${String(inner.code)})` : "";
  return `${message}${code}`;
}

main().catch((err: unknown) => {
  // Message and code only: a stack or the error object could echo connection details.
  process.stderr.write(`[@ct/db] migration failed: ${describe(err)}\n`);
  process.exitCode = 1;
});
