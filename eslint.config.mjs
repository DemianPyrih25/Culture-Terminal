import { defineConfig, globalIgnores } from "eslint/config";
import nextVitals from "eslint-config-next/core-web-vitals";
import nextTs from "eslint-config-next/typescript";

const SERVER_ONLY_PACKAGES = ["@ct/agent", "@ct/agent/*", "@ct/qloo", "@ct/qloo/*", "@ct/db", "@ct/db/*"];

export default defineConfig([
  ...nextVitals,
  ...nextTs,
  {
    // React lives in apps/web, so the version is stated rather than detected from the root.
    settings: { next: { rootDir: "apps/web/" }, react: { version: "19.3" } },
  },
  {
    // Client code never imports the agent, the Qloo client or the database (PLAN §10.1).
    files: ["apps/web/components/**", "apps/web/lib/**"],
    rules: {
      "no-restricted-imports": [
        "error",
        {
          patterns: [
            {
              group: SERVER_ONLY_PACKAGES,
              message: "Server-only package: import it from apps/web/server/* only.",
            },
          ],
        },
      ],
    },
  },
  {
    // Dependency-free tools run on Node type stripping and probe loosely typed JSON.
    files: ["tools/**/*.ts"],
    rules: { "@typescript-eslint/no-explicit-any": "off" },
  },
  globalIgnores([
    "**/node_modules/**",
    "**/.next/**",
    "**/.next-*/**",
    "**/out/**",
    "**/build/**",
    "**/dist/**",
    "**/coverage/**",
    "apps/web/next-env.d.ts",
    "packages/db/drizzle/**",
    ".probe/**",
    ".private/**",
    "eval/raw/**",
  ]),
]);
