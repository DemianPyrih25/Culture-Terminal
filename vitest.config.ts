import path from "node:path";
import { defineConfig } from "vitest/config";

export default defineConfig({
  // The web app's "@/..." imports, as in apps/web/tsconfig.json.
  resolve: { alias: { "@": path.resolve(import.meta.dirname, "apps/web") } },
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
