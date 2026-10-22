import { defineConfig } from "drizzle-kit";

// `generate` reads only the schema. The URL is used by `drizzle-kit studio` and `check` against
// a live database; it falls back to the docker-compose database like the runtime client does.
export default defineConfig({
  dialect: "postgresql",
  schema: "./src/schema.ts",
  out: "./drizzle",
  dbCredentials: {
    url: process.env.DATABASE_URL ?? "postgres://ct:ct@localhost:5433/culture_terminal",
  },
  strict: true,
  verbose: true,
});
