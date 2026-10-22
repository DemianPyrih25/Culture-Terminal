// Output for the dev CLIs. Commands write lines through CliIo, so tests capture them without
// touching the console.
import { terminalSafe } from "./table";

export interface CliIo {
  out(line: string): void;
  err(line: string): void;
}

/**
 * The same io with every line passed through terminalSafe. Each command wraps the io it is given,
 * so no Qloo name, kit message or LLM sentence can carry an escape sequence to the terminal.
 */
export function safeIo(io: CliIo): CliIo {
  return { out: (line) => io.out(terminalSafe(line)), err: (line) => io.err(terminalSafe(line)) };
}

export const consoleIo: CliIo = {
  out: (line) => process.stdout.write(`${line}\n`),
  err: (line) => process.stderr.write(`${line}\n`),
};

/** A CliIo that keeps every line, for tests. */
export function memoryIo(): CliIo & { stdout: string[]; stderr: string[]; text(): string } {
  const stdout: string[] = [];
  const stderr: string[] = [];
  return {
    stdout,
    stderr,
    out: (line) => stdout.push(line),
    err: (line) => stderr.push(line),
    text: () => stdout.join("\n"),
  };
}

/** A section heading. */
export function heading(title: string): string {
  return `\n${title}`;
}

/** Exit codes shared by the CLIs. */
export const EXIT = { ok: 0, failed: 1, usage: 2, needsInput: 3 } as const;
