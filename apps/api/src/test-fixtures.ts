import { randomUUID } from "node:crypto";
import type { PlannerItem } from "@calo/core";
import { eq } from "drizzle-orm";
import { db } from "./db.ts";
import { encrypt } from "./encryption.ts";
import { canvasConnections, googleConnections, syncedEvents, users } from "./schema.ts";

const DAY_MS = 24 * 60 * 60 * 1000;

/**
 * A new student. Every test makes its own, so tests never share rows: every
 * query in sync.ts and google-push.ts is scoped to one user.
 */
export async function newUser() {
  const [user] = await db
    .insert(users)
    .values({ email: `${randomUUID()}@sfu.ca` })
    .returning();
  return user!;
}

export async function connectCanvas(
  userId: string,
  method: "token" | "feed" = "token",
  secret = "canvas-token",
) {
  await db.insert(canvasConnections).values({ userId, method, secret: encrypt(secret, userId) });
}

export const REFRESH_TOKEN = "refresh-token";

export async function connectGoogle(userId: string, revokedAt: Date | null = null) {
  await db
    .insert(googleConnections)
    .values({ userId, refreshToken: encrypt(REFRESH_TOKEN, userId), revokedAt });
}

export async function googleConnectionRow(userId: string) {
  const [row] = await db
    .select()
    .from(googleConnections)
    .where(eq(googleConnections.userId, userId));
  return row;
}

/** The user's synced_events rows, by event id. */
export async function syncedRows(userId: string) {
  const rows = await db.select().from(syncedEvents).where(eq(syncedEvents.userId, userId));
  return new Map(rows.map((row) => [row.eventId, row]));
}

// Whole seconds, like Canvas's timestamps, and fixed for the whole run, so an
// item built twice comes out the same.
const NOW = Math.floor(Date.now() / 1000) * 1000;

/** A planner assignment due `days` from now, well inside the window sync pulls. */
export function assignment(id: number, days = 7, title = `Assignment ${id}`): PlannerItem {
  return {
    plannable_type: "assignment",
    plannable_id: id,
    plannable_date: new Date(NOW + days * DAY_MS).toISOString(),
    html_url: `/courses/18618/assignments/${id}`,
    context_name: "CMPT307 D200 Data Structures and Algorithms",
    plannable: { title },
  };
}

export function daysFromNow(days: number): Date {
  return new Date(NOW + days * DAY_MS);
}
