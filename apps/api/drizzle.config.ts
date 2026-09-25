import { defineConfig } from "drizzle-kit";

// drizzle-kit doesn't read .env on its own; Node's built-in loader does.
process.loadEnvFile();

export default defineConfig({
  dialect: "postgresql",
  schema: "./src/schema.ts",
  dbCredentials: { url: process.env.DATABASE_URL! },
});
