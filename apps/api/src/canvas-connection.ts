import {
  CanvasError,
  canvasFeedUrl,
  fetchCanvasFeed,
  parseCanvasFeed,
  verifyCanvasToken,
} from "@calo/core";
import { eq, sql } from "drizzle-orm";
import { Hono, type Context } from "hono";
import { db } from "./db.ts";
import { encrypt } from "./encryption.ts";
import { canvasConnections, type User } from "./schema.ts";
import { requireSession } from "./session.ts";

// Mounted at /api/canvas/connection. The token or feed URL never goes back
// out: errors are fixed strings, and status never reads the secret column.
export const canvasConnection = new Hono<{ Variables: { user: User } }>();

canvasConnection.use(requireSession);

canvasConnection.get("/", async (c) => {
  const [row] = await db
    .select({ method: canvasConnections.method, connectedAt: canvasConnections.connectedAt })
    .from(canvasConnections)
    .where(eq(canvasConnections.userId, c.get("user").id));
  return c.json(row ? { connected: true, ...row } : { connected: false });
});

canvasConnection.put("/token", async (c) => {
  const token = await readField(c, "token");
  // Printable ASCII, no spaces: all a header can hold. Node's error for a bad
  // header value quotes the value, which would put the token in the logs.
  if (!/^[\x21-\x7e]+$/.test(token)) {
    return c.json({ error: "That doesn't look like a Canvas access token." }, 400);
  }
  try {
    await verifyCanvasToken(token);
  } catch (err) {
    if (!(err instanceof CanvasError)) throw err;
    if (err.status === 401) {
      return c.json({ error: "Canvas didn't accept this token." }, 400);
    }
    return c.json({ error: "Canvas returned an error. Try again later." }, 502);
  }
  return c.json(await save(c.get("user").id, "token", token));
});

canvasConnection.put("/feed", async (c) => {
  const url = canvasFeedUrl(await readField(c, "url"));
  if (!url) {
    return c.json({ error: "That isn't a canvas.sfu.ca calendar feed URL." }, 400);
  }
  let ics: string;
  try {
    ics = await fetchCanvasFeed(url);
  } catch (err) {
    if (!(err instanceof CanvasError)) throw err;
    // What canvas.sfu.ca answers for a feed code it doesn't know.
    if (err.status === 400) {
      return c.json({ error: "Canvas doesn't recognize this feed URL." }, 400);
    }
    return c.json({ error: "Canvas returned an error. Try again later." }, 502);
  }
  // Throws on a feed sync wouldn't be able to read, before it's saved.
  parseCanvasFeed(ics);
  return c.json(await save(c.get("user").id, "feed", url));
});

canvasConnection.delete("/", async (c) => {
  await db.delete(canvasConnections).where(eq(canvasConnections.userId, c.get("user").id));
  return c.body(null, 204);
});

// A string field of the JSON body, trimmed since these are pasted. A missing
// or malformed body gives "", which the routes reject with a 400.
async function readField(c: Context, name: string): Promise<string> {
  const body = await c.req.json().catch(() => null);
  const value = body?.[name];
  return typeof value === "string" ? value.trim() : "";
}

async function save(userId: string, method: "token" | "feed", plaintext: string) {
  const secret = encrypt(plaintext, userId);
  const [row] = await db
    .insert(canvasConnections)
    .values({ userId, method, secret })
    .onConflictDoUpdate({
      target: canvasConnections.userId,
      set: { method, secret, connectedAt: sql`now()` },
    })
    .returning({ method: canvasConnections.method, connectedAt: canvasConnections.connectedAt });
  return { connected: true, ...row! };
}
