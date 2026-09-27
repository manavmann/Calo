import { pgEnum, pgTable, text, timestamp, uuid } from "drizzle-orm/pg-core";

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

export const canvasMethod = pgEnum("canvas_method", ["token", "feed"]);

// One per user, so connecting again replaces it: a token and a feed for the
// same account hold the same deadlines, and sync reads from one place.
export const canvasConnections = pgTable("canvas_connections", {
  userId: uuid("user_id")
    .primaryKey()
    .references(() => users.id, { onDelete: "cascade" }),
  method: canvasMethod("method").notNull(),
  /**
   * The access token or feed URL, encrypted (see encryption.ts). One column
   * for both, so a row can't have both or neither.
   */
  secret: text("secret").notNull(),
  connectedAt: timestamp("connected_at", { withTimezone: true }).notNull().defaultNow(),
});

export type User = typeof users.$inferSelect;
