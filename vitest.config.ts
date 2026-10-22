import { defineConfig } from "vitest/config";

export default defineConfig({
  test: {
    include: [
      "packages/*/src/**/*.test.ts",
      "packages/*/test/**/*.test.ts",
      "apps/web/**/*.test.{ts,tsx}",
      "tools/**/*.test.ts",
    ],
    exclude: ["**/node_modules/**", "**/.next/**", "**/.next-*/**"],
    environment: "node",
  },
});
