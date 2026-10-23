// Screenshots a page of the local web app for visual checks against the design exports
// (design/exports/concept-a/png, gitignored). Write images outside the repo or under .private/.
//
//   pnpm exec tsx tools/dev/screenshot.ts <url> <out.png> [--width 1440] [--height 900] [--full]
//                                         [--wait <selector>] [--delay <ms>]
import { chromium } from "@playwright/test";

interface ShotArgs {
  url: string;
  out: string;
  width: number;
  height: number;
  full: boolean;
  wait: string | null;
  delayMs: number;
}

function parseArgs(argv: readonly string[]): ShotArgs {
  const [url, out, ...rest] = argv;
  if (!url || !out) throw new Error("usage: screenshot.ts <url> <out.png> [--width N] [--height N] [--full] [--wait sel] [--delay ms]");
  const args: ShotArgs = { url, out, width: 1440, height: 900, full: false, wait: null, delayMs: 300 };
  for (let i = 0; i < rest.length; i += 1) {
    const flag = rest[i];
    if (flag === "--full") {
      args.full = true;
      continue;
    }
    const value = rest[i + 1];
    if (value === undefined) throw new Error(`${flag} needs a value`);
    i += 1;
    if (flag === "--width") args.width = Number(value);
    else if (flag === "--height") args.height = Number(value);
    else if (flag === "--wait") args.wait = value;
    else if (flag === "--delay") args.delayMs = Number(value);
    else throw new Error(`unknown argument: ${flag}`);
  }
  return args;
}

const args = parseArgs(process.argv.slice(2));
const browser = await chromium.launch();
try {
  const page = await browser.newPage({ viewport: { width: args.width, height: args.height } });
  await page.goto(args.url, { waitUntil: "networkidle" });
  if (args.wait) await page.waitForSelector(args.wait);
  // A string expression: the tools tsconfig has no DOM lib.
  await page.evaluate("document.fonts.ready");
  await page.waitForTimeout(args.delayMs);
  await page.screenshot({ path: args.out, fullPage: args.full });
  console.log(`wrote ${args.out}`);
} finally {
  await browser.close();
}
