import type { BaseLogger } from "pino";

/** The pino methods the client uses; a pino Logger satisfies it. Log fields never include the API key. */
export type QlooLogger = Pick<BaseLogger, "debug" | "info" | "warn" | "error">;

const noop = (): void => undefined;

export const SILENT_LOGGER: QlooLogger = { debug: noop, info: noop, warn: noop, error: noop };
