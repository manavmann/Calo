import {
  fetchCanvasFeed,
  fetchPlannerItems,
  normalizePlannerItems,
  parseCanvasFeed,
  type CaloEvent,
  type PlannerItem,
} from "@calo/core";
import { and, eq, inArray, sql } from "drizzle-orm";
import { db } from "./db.ts";
import { decrypt } from "./encryption.ts";
import { canvasConnections, syncedEvents } from "./schema.ts";
import { contentHash, diffEvents } from "./sync-diff.ts";

const DAY_MS = 24 * 60 * 60 * 1000;

// The planner window the token path asks for. The extension asks for the same
// one (see extension.ts), so both give the same events.
export const PLANNER_PAST_DAYS = 14;
export const PLANNER_FUTURE_DAYS = 90;

// The feed has no window parameter. Canvas serves a user feed from 30 days
// back to 366 ahead (CalendarEventsApiController#public_feed in canvas-lms).
const FEED_PAST_DAYS = 30;
const FEED_FUTURE_DAYS = 366;

type SyncResult = { added: string[]; changed: string[]; deleted: string[] };

/** What a pull from Canvas found, and where a missing event counts as deleted. */
interface Pull {
  events: CaloEvent[];
  ambiguousIds: string[];
  window: { start: Date; end: Date };
}

/**
 * Brings the user's synced_events in line with Canvas, and returns the ids
 * the calendar has to add, update, or remove. Unchanged rows aren't written.
 * Assumes only one sync runs for a user at a time.
 */
export async function syncUser(userId: string): Promise<SyncResult> {
  const [connection] = await db
    .select()
    .from(canvasConnections)
    .where(eq(canvasConnections.userId, userId));
  if (!connection) {
    throw new Error(`User ${userId} has no Canvas connection`);
  }
  // There's nothing to pull with: the extension posts this user's items
  // itself, through ingestPlannerItems.
  if (connection.method === "extension") {
    throw new Error(`User ${userId}'s Canvas items come from the extension`);
  }

  // Pulled before the transaction, so it isn't held open during a network
  // call. A Canvas error throws here, before anything is written, so a failed
  // pull can't look like every event was deleted. The secret is there for a
  // token or feed: schema.ts checks it.
  const pull = await pullFromCanvas(connection.method, decrypt(connection.secret!, userId));
  return applyPull(userId, pull);
}

/**
 * syncUser for the extension, with the planner items it pulled from Canvas
 * between `pulled.start` and `pulled.end`. Those come from the extension's
 * clock, not the server's: worked out again here, the window could take in
 * days the extension never asked Canvas for, and delete their events.
 */
export async function ingestPlannerItems(
  userId: string,
  items: PlannerItem[],
  pulled: { start: Date; end: Date },
): Promise<SyncResult> {
  return applyPull(userId, {
    events: normalizePlannerItems(items),
    ambiguousIds: [],
    window: trustedWindow(pulled.start, pulled.end),
  });
}

async function applyPull(userId: string, pull: Pull): Promise<SyncResult> {
  return db.transaction(async (tx) => {
    const stored = await tx
      .select({
        eventId: syncedEvents.eventId,
        contentHash: syncedEvents.contentHash,
        start: syncedEvents.start,
        deletedAt: syncedEvents.deletedAt,
      })
      .from(syncedEvents)
      .where(eq(syncedEvents.userId, userId));
    const { added, changed, deleted } = diffEvents(
      stored,
      pull.events,
      pull.window,
      pull.ambiguousIds,
    );

    const upserts = [...added, ...changed];
    if (upserts.length > 0) {
      await tx
        .insert(syncedEvents)
        .values(upserts.map((event) => toRow(userId, event)))
        .onConflictDoUpdate({
          target: [syncedEvents.userId, syncedEvents.eventId],
          set: {
            kind: sql`excluded.kind`,
            title: sql`excluded.title`,
            course: sql`excluded.course`,
            url: sql`excluded.url`,
            start: sql`excluded.start_at`,
            end: sql`excluded.end_at`,
            allDay: sql`excluded.all_day`,
            contentHash: sql`excluded.content_hash`,
            deletedAt: null,
          },
        });
    }
    if (deleted.length > 0) {
      await tx
        .update(syncedEvents)
        .set({ deletedAt: sql`now()` })
        .where(and(eq(syncedEvents.userId, userId), inArray(syncedEvents.eventId, deleted)));
    }

    return {
      added: added.map((event) => event.id),
      changed: changed.map((event) => event.id),
      deleted,
    };
  });
}

// Known limitation: the planner calls a graded quiz or discussion quiz-N or
// discussion-N, and the feed calls the same item assignment-M. A user who
// switches methods has those tombstoned under one id and added under the other.
async function pullFromCanvas(method: "token" | "feed", secret: string): Promise<Pull> {
  const now = Date.now();
  if (method === "token") {
    const start = new Date(now - PLANNER_PAST_DAYS * DAY_MS);
    const end = new Date(now + PLANNER_FUTURE_DAYS * DAY_MS);
    return {
      events: normalizePlannerItems(await fetchPlannerItems(secret, start, end)),
      ambiguousIds: [],
      window: trustedWindow(start, end),
    };
  }
  const { events, ambiguousIds } = parseCanvasFeed(await fetchCanvasFeed(secret));
  return {
    events,
    ambiguousIds,
    window: trustedWindow(
      new Date(now - FEED_PAST_DAYS * DAY_MS),
      new Date(now + FEED_FUTURE_DAYS * DAY_MS),
    ),
  };
}

// Where a missing event counts as deleted: the pulled window less a day at each
// end. Canvas works out the feed's window on its own clock, in calendar days
// that shift an hour across DST, and it isn't documented whether the planner
// rounds its dates to whole days, so the exact edges can't be trusted. Missing
// a deletion at the edge costs little; a wrong one takes a real deadline off
// the student's calendar.
function trustedWindow(start: Date, end: Date) {
  return {
    start: new Date(start.getTime() + DAY_MS),
    end: new Date(end.getTime() - DAY_MS),
  };
}

function toRow(userId: string, event: CaloEvent) {
  return {
    userId,
    eventId: event.id,
    kind: event.kind,
    title: event.title,
    course: event.course,
    url: event.url,
    start: new Date(event.start),
    end: event.end === null ? null : new Date(event.end),
    allDay: event.allDay,
    contentHash: contentHash(event),
  };
}

// The reverse of toRow. Both outputs (google-push.ts, feed.ts) read rows
// through this, so they can't turn the same row into different events.
export function toEvent(row: typeof syncedEvents.$inferSelect): CaloEvent {
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
