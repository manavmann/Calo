import {
  boolean,
  pgEnum,
  pgTable,
  primaryKey,
  text,
  timestamp,
  uuid,
} from "drizzle-orm/pg-core";

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

export const eventKind = pgEnum("event_kind", ["assignment", "quiz", "discussion", "event"]);

// The last version sync saw of each of a user's Canvas items (see sync.ts).
// Sync never deletes a row: an item gone from Canvas gets deleted_at, so the
// outputs can tell it's gone and remove it from the student's calendar.
export const syncedEvents = pgTable(
  "synced_events",
  {
    // References users, not canvas_connections: disconnecting shouldn't drop
    // the record of what was sent to the student's calendar.
    userId: uuid("user_id")
      .notNull()
      .references(() => users.id, { onDelete: "cascade" }),
    /** CaloEvent.id, e.g. "quiz-4821". Unique per user, not overall. */
    eventId: text("event_id").notNull(),
    kind: eventKind("kind").notNull(),
    title: text("title").notNull(),
    course: text("course").notNull(),
    url: text("url").notNull(),
    // Named like Canvas's own columns; END on its own is reserved in SQL.
    start: timestamp("start_at", { withTimezone: true }).notNull(),
    end: timestamp("end_at", { withTimezone: true }),
    allDay: boolean("all_day").notNull(),
    /** contentHash() of the event as last synced. */
    contentHash: text("content_hash").notNull(),
    /** When sync found the item gone from Canvas. Null while it's live. */
    deletedAt: timestamp("deleted_at", { withTimezone: true }),
  },
  (t) => [primaryKey({ columns: [t.userId, t.eventId] })],
);

export type User = typeof users.$inferSelect;
