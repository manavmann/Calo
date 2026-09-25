import { drizzle } from "drizzle-orm/postgres-js";
import postgres from "postgres";

const url = process.env.DATABASE_URL;
if (!url) {
  throw new Error("DATABASE_URL is not set. Copy apps/api/.env.example to apps/api/.env.");
}

// postgres.js connects lazily, on the first query, so importing this is cheap.
export const db = drizzle(postgres(url));
