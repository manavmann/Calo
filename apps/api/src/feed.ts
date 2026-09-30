import { randomBytes } from "node:crypto";
import { generateIcs } from "@calo/core";
import { and, asc, eq, isNull } from "drizzle-orm";
import { Hono } from "hono";
import { db } from "./db.ts";
import { decrypt, encrypt } from "./encryption.ts";
import { feeds, syncedEvents, type User } from "./schema.ts";
import { hashToken, requireSession } from "./session.ts";
import { toEvent } from "./sync.ts";

// Mounted at /f. What Apple Calendar or any other ICS client subscribes to.
// They fetch it on their own schedule and can't send a cookie, so the token in
// the URL is the only credential: whoever has the URL can read the feed. For
// the same reason, anything that logs request paths would log working feeds.
export const feed = new Hono();

// A token that's unknown, was replaced, or isn't a token at all gets the same
// 404 as any other missing page, so probing learns nothing. Not 401: that asks
// for credentials, and some calendar apps answer it by prompting for a
// username and password. There's no rate limit, since no request rate makes
// guessing 256 random bits feasible.
feed.get("/:file{[^/]+\\.ics}", async (c) => {
  const token = c.req.param("file").slice(0, -".ics".length);
  const [row] = await db
    .select({ userId: feeds.userId })
    .from(feeds)
    .where(eq(feeds.tokenHash, hashToken(token)));
  if (!row) {
    return c.notFound();
  }

  // Only what sync has stored, never a fresh pull from Canvas: every client's
  // polling, or anyone holding the URL, would otherwise send requests to Canvas
  // with the student's token. Tombstoned events are left out, and that's all
  // removing them takes, since a client replaces its copy on every fetch.
  const rows = await db
    .select()
    .from(syncedEvents)
    .where(and(eq(syncedEvents.userId, row.userId), isNull(syncedEvents.deletedAt)))
    .orderBy(asc(syncedEvents.start), asc(syncedEvents.eventId));
  return c.body(generateIcs(rows.map(toEvent), new Date()), 200, {
    "Content-Type": "text/calendar; charset=utf-8",
  });
});

// Mounted at /api/feed. Where the student gets their feed URL, and a new one
// if the old one got out.
export const feedUrl = new Hono<{ Variables: { user: User } }>();

feedUrl.use(requireSession);

feedUrl.get("/", async (c) => {
  const userId = c.get("user").id;
  const [row] = await db
    .select({ token: feeds.token })
    .from(feeds)
    .where(eq(feeds.userId, userId));
  return c.json({ path: row ? feedPath(decrypt(row.token, userId)) : null });
});

// Makes the student's feed URL, or replaces it. The old URL stops working at
// once, and anything subscribed to it has to subscribe to the new one: there's
// no way to hand a calendar app a new URL.
feedUrl.post("/", async (c) => {
  const userId = c.get("user").id;
  // 256 random bits, like a session token.
  const token = randomBytes(32).toString("base64url");
  const values = { tokenHash: hashToken(token), token: encrypt(token, userId) };
  await db
    .insert(feeds)
    .values({ userId, ...values })
    .onConflictDoUpdate({ target: feeds.userId, set: values });
  return c.json({ path: feedPath(token) });
});

// Just the path: nothing tells the API the hostname it's reached at. The
// dashboard is served from the same origin, so it adds webcal:// and its host.
function feedPath(token: string): string {
  return `/f/${token}.ics`;
}
