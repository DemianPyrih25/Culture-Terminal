import "server-only";
import { pino } from "pino";

// JSON logs (PLAN §10.3). Tests stay quiet unless LOG_LEVEL asks otherwise. An empty LOG_LEVEL
// (as copied from .env.example) counts as unset; pino throws on "".
export const log = pino({
  level: process.env.LOG_LEVEL?.trim() || (process.env.VITEST ? "silent" : "info"),
  base: { service: "web" },
  redact: { paths: ["*.apiKey", "*.headers.x-api-key", "*.headers.authorization"], remove: true },
});

export type Logger = typeof log;
