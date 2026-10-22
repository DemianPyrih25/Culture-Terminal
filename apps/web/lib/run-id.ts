// Run ids are database-generated UUIDs today; the check stays loose so short permalink ids can come
// later, but it keeps arbitrary path segments away from the database.
const RUN_ID = /^[A-Za-z0-9-]{8,64}$/;

export function isRunId(value: unknown): value is string {
  return typeof value === "string" && RUN_ID.test(value);
}
