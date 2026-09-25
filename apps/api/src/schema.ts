import { pgTable, text, timestamp, uuid } from "drizzle-orm/pg-core";

export const users = pgTable("users", {
  // Random rather than sequential: ids reach the browser, and shouldn't reveal
  // how many users there are or in what order they signed up.
  id: uuid("id").primaryKey().defaultRandom(),
  /** Lowercased on write. The only identity until Google sign-in exists. */
  email: text("email").notNull().unique(),
  // Nothing reads this yet, but a signup time can't be backfilled truthfully later.
  createdAt: timestamp("created_at", { withTimezone: true }).notNull().defaultNow(),
});

export const sessions = pgTable("sessions", {
  /** SHA-256 of the token in the cookie, never the token itself. */
  id: text("id").primaryKey(),
  userId: uuid("user_id")
    .notNull()
    .references(() => users.id, { onDelete: "cascade" }),
  expiresAt: timestamp("expires_at", { withTimezone: true }).notNull(),
});

export type User = typeof users.$inferSelect;
