// `pnpm guard`: the repository data guard (PLAN §10.2, D29). See cli.ts for the modes.
import { fileURLToPath } from "node:url";
import { main } from "./cli";

const root = fileURLToPath(new URL("../..", import.meta.url));
process.exitCode = main(process.argv.slice(2), root);
