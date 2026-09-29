import {
  createGoogleCalendar,
  deleteGoogleEvent,
  googleCalendarExists,
  refreshGoogleAccessToken,
  upsertGoogleEvent,
  type CaloEvent,
} from "@calo/core";
import { and, eq, isNotNull, isNull, sql } from "drizzle-orm";
import { db } from "./db.ts";
import { decrypt } from "./encryption.ts";
import { googleClient } from "./google-client.ts";
import { googleConnections, syncedEvents } from "./schema.ts";

export type PushResult =
  | { status: "not connected" }
  | { status: "needs reconnect" }
  | { status: "pushed"; newCalendar: boolean; written: string[]; removed: string[] };

/**
 * Brings the student's Calo calendar in Google in line with synced_events.
 * The work comes from google_hash on each row, not from what sync returned:
 * sync has already committed by now, so if a push dies partway, the next one
 * picks up where it stopped. Assumes only one push runs for a user at a time.
 */
export async function pushToGoogle(userId: string): Promise<PushResult> {
  const [connection] = await db
    .select()
    .from(googleConnections)
    .where(eq(googleConnections.userId, userId));
  if (!connection) {
    return { status: "not connected" };
  }
  if (connection.revokedAt !== null) {
    return { status: "needs reconnect" };
  }

  // A new one every push, never stored: it lasts an hour, far longer than a
  // push takes. If the student revokes access mid-push, a later call fails
  // with 401 and throws, and the next push's refresh finds the token dead.
  const accessToken = await refreshGoogleAccessToken(
    googleClient,
    decrypt(connection.refreshToken, userId),
  );
  if (accessToken === null) {
    // Pushing stops until the student reconnects. Their rows stay pending, so
    // reconnecting catches the calendar up.
    await db
      .update(googleConnections)
      .set({ revokedAt: sql`now()` })
      .where(eq(googleConnections.userId, userId));
    return { status: "needs reconnect" };
  }

  // Checked every push, not only when there's something to write, so a
  // deleted calendar comes back on the next sync, not the next time
  // something changes on Canvas.
  let calendarId = connection.calendarId;
  let newCalendar = false;
  if (calendarId === null || !(await googleCalendarExists(accessToken, calendarId))) {
    calendarId = await createGoogleCalendar(accessToken);
    newCalendar = true;
    // Nothing is on the new calendar, so every live event is pending again,
    // and no tombstone has anything left to delete.
    await db.transaction(async (tx) => {
      await tx
        .update(googleConnections)
        .set({ calendarId })
        .where(eq(googleConnections.userId, userId));
      await tx
        .update(syncedEvents)
        .set({ googleHash: null })
        .where(eq(syncedEvents.userId, userId));
    });
  }

  // Events gone from Canvas that are still in Google.
  const toRemove = await db
    .select({ eventId: syncedEvents.eventId })
    .from(syncedEvents)
    .where(
      and(
        eq(syncedEvents.userId, userId),
        isNotNull(syncedEvents.deletedAt),
        isNotNull(syncedEvents.googleHash),
      ),
    );
  // Live events Google doesn't have yet, or has an older version of.
  const toWrite = await db
    .select()
    .from(syncedEvents)
    .where(
      and(
        eq(syncedEvents.userId, userId),
        isNull(syncedEvents.deletedAt),
        sql`${syncedEvents.googleHash} is distinct from ${syncedEvents.contentHash}`,
      ),
    );

  // One call at a time, each recorded as soon as it succeeds. A first push is
  // a few hundred calls at most, well under Google's per-user rate limit.
  for (const { eventId } of toRemove) {
    await deleteGoogleEvent(accessToken, calendarId, eventId);
    await setGoogleHash(userId, eventId, null);
  }
  for (const row of toWrite) {
    await upsertGoogleEvent(accessToken, calendarId, toEvent(row));
    // The hash of what was sent, so a row sync changed in the meantime stays pending.
    await setGoogleHash(userId, row.eventId, row.contentHash);
  }

  return {
    status: "pushed",
    newCalendar,
    written: toWrite.map((row) => row.eventId),
    removed: toRemove.map((row) => row.eventId),
  };
}

async function setGoogleHash(userId: string, eventId: string, googleHash: string | null) {
  await db
    .update(syncedEvents)
    .set({ googleHash })
    .where(and(eq(syncedEvents.userId, userId), eq(syncedEvents.eventId, eventId)));
}

// The reverse of toRow in sync.ts.
function toEvent(row: typeof syncedEvents.$inferSelect): CaloEvent {
  return {
    id: row.eventId,
    kind: row.kind,
    title: row.title,
    course: row.course,
    url: row.url,
    start: row.start.toISOString(),
    end: row.end === null ? null : row.end.toISOString(),
    allDay: row.allDay,
  };
}
