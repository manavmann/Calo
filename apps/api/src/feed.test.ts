import { createHash, randomBytes } from "node:crypto";
import { generateIcs } from "@calo/core";
import { eq } from "drizzle-orm";
import { Hono } from "hono";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { db } from "./db.ts";
import { decrypt } from "./encryption.ts";
import { fakeNetwork } from "./fake-network.ts";
import { feed, feedUrl } from "./feed.ts";
import { feeds, sessions } from "./schema.ts";
import { createSession, hashToken, invalidateSession, SESSION_COOKIE } from "./session.ts";
import { syncUser } from "./sync.ts";
import { assignment, connectCanvas, newUser } from "./test-fixtures.ts";

// Mounted where server.ts mounts them. server.ts itself isn't imported, since
// it starts listening on a port. It sets no 404 handler of its own, so this
// app's 404 is the same one production serves.
const app = new Hono().route("/api/feed", feedUrl).route("/f", feed);

let network: ReturnType<typeof fakeNetwork>;
let userId: string;
let session: string;

beforeEach(async () => {
  network = fakeNetwork();
  userId = (await newUser()).id;
  session = await sessionCookie(userId);
});

afterEach(() => {
  vi.unstubAllGlobals();
});

async function sessionCookie(userId: string): Promise<string> {
  return `${SESSION_COOKIE}=${(await createSession(userId)).token}`;
}

function getFeedUrl(cookie = session) {
  return app.request("/api/feed", { headers: { Cookie: cookie } });
}

/** Makes the student's feed URL, or replaces it, and returns its path. */
async function newFeed(cookie = session): Promise<string> {
  const res = await app.request("/api/feed", { method: "POST", headers: { Cookie: cookie } });
  expect(res.status).toBe(200);
  return ((await res.json()) as { path: string }).path;
}

function tokenOf(path: string): string {
  return path.slice("/f/".length, -".ics".length);
}

/** The Calo ids of a feed's events, in the order it lists them. */
function eventIds(ics: string): string[] {
  return [...ics.matchAll(/^UID:(.*)@calo\r$/gm)].map((match) => match[1]!);
}

async function feedEventIds(path: string): Promise<string[]> {
  const res = await app.request(path);
  expect(res.status).toBe(200);
  return eventIds(await res.text());
}

/** Everything a client can tell apart about a response. */
async function observable(res: Response) {
  return { status: res.status, headers: Object.fromEntries(res.headers), body: await res.text() };
}

/** The app's 404 for a path that has nothing to do with feeds. */
async function plainNotFound(method = "GET") {
  return observable(await app.request("/nothing-here", { method }));
}

async function expectRefused(cookie?: string) {
  const headers = cookie ? { Cookie: cookie } : undefined;
  for (const method of ["GET", "POST"]) {
    const res = await app.request("/api/feed", { method, headers });
    expect(res.status).toBe(401);
    expect(await res.json()).toEqual({ error: "unauthorized" });
  }
}

describe("/api/feed", () => {
  // GET is the one that matters most: it hands back a working feed URL.
  it("refuses GET and POST without a session", async () => {
    await newFeed();
    await expectRefused();
  });

  it("refuses an expired session", async () => {
    const token = randomBytes(32).toString("base64url");
    await db
      .insert(sessions)
      .values({ id: hashToken(token), userId, expiresAt: new Date(Date.now() - 1000) });
    await expectRefused(`${SESSION_COOKIE}=${token}`);
  });

  it("refuses a session after logout", async () => {
    const { token } = await createSession(userId);
    const cookie = `${SESSION_COOKIE}=${token}`;
    expect((await getFeedUrl(cookie)).status).toBe(200);
    await invalidateSession(token);
    await expectRefused(cookie);
  });

  it("has no URL to show before the student makes one", async () => {
    expect(await (await getFeedUrl()).json()).toEqual({ path: null });
  });

  // 43 base64url characters is 256 random bits, which is why the feed has no
  // rate limit. Plain base64 could put a "/" in the token and break the route.
  it("makes an unguessable URL, stores its token only hashed and encrypted, and shows it again", async () => {
    const path = await newFeed();
    expect(path).toMatch(/^\/f\/[A-Za-z0-9_-]{43}\.ics$/);
    const token = tokenOf(path);

    const [row] = await db.select().from(feeds).where(eq(feeds.userId, userId));
    expect(row!.tokenHash).toBe(createHash("sha256").update(token).digest("hex"));
    expect(row!.token).not.toContain(token);
    expect(decrypt(row!.token, userId)).toBe(token);

    expect(await (await getFeedUrl()).json()).toEqual({ path });
  });
});

describe("/f/<token>.ics", () => {
  // With no events there's no DTSTAMP, so the whole body is known in advance.
  it("serves an empty calendar to a student with nothing synced", async () => {
    const res = await app.request(await newFeed());
    expect(res.status).toBe(200);
    expect(res.headers.get("content-type")).toBe("text/calendar; charset=utf-8");
    expect(await res.text()).toBe(generateIcs([], new Date()));
  });

  it("lists live events by due time, leaves out ones gone from Canvas, and doesn't ask Canvas", async () => {
    await connectCanvas(userId);
    // Synced in the reverse of the feed's order, so a missing ORDER BY can't
    // pass by accident. 2 and 3 are due at the same time, like two deadlines
    // at 11:59 PM, so they fall back to id order.
    network.canvas.items = [
      assignment(5, 8),
      assignment(4, 10),
      assignment(3, 5),
      assignment(2, 5),
      assignment(1, 2),
    ];
    await syncUser(userId);
    network.canvas.items = network.canvas.items.slice(1);
    expect((await syncUser(userId)).deleted).toEqual(["assignment-5"]);

    // Serving only reads what sync stored. A pull here would send Canvas a
    // request with the student's token every time any client polled the URL.
    const path = await newFeed();
    const requests = network.requests.length;
    expect(await feedEventIds(path)).toEqual([
      "assignment-1",
      "assignment-2",
      "assignment-3",
      "assignment-4",
    ]);
    expect(network.requests.length).toBe(requests);
  });

  it("serves each student only their own events", async () => {
    const classmate = (await newUser()).id;
    const classmateSession = await sessionCookie(classmate);
    await connectCanvas(userId);
    network.canvas.items = [assignment(1)];
    await syncUser(userId);
    await connectCanvas(classmate);
    network.canvas.items = [assignment(2)];
    await syncUser(classmate);

    const path = await newFeed();
    const classmatePath = await newFeed(classmateSession);
    expect(await feedEventIds(path)).toEqual(["assignment-1"]);
    expect(await feedEventIds(classmatePath)).toEqual(["assignment-2"]);
    expect(await (await getFeedUrl()).json()).toEqual({ path });
    expect(await (await getFeedUrl(classmateSession)).json()).toEqual({ path: classmatePath });
  });

  // Hono answers HEAD by running the GET handler and dropping the body.
  it("answers HEAD like GET, without the body", async () => {
    const res = await app.request(await newFeed(), { method: "HEAD" });
    expect(res.status).toBe(200);
    expect(res.headers.get("content-type")).toBe("text/calendar; charset=utf-8");
    expect(await res.text()).toBe("");
  });

  // Not just any 404: one that differs from the app's usual 404 tells whoever
  // is probing that their path reached the feed route.
  describe("a URL that isn't the student's current feed", () => {
    let token: string;

    beforeEach(async () => {
      token = tokenOf(await newFeed());
      // So each case below differs from a working URL in one way only.
      expect((await app.request(`/f/${token}.ics`)).status).toBe(200);
    });

    it.each([
      { name: "an unknown token", path: () => `/f/${randomBytes(32).toString("base64url")}.ics` },
      { name: "no .ics", path: () => `/f/${token}` },
      { name: ".ICS", path: () => `/f/${token}.ICS` },
      { name: "the token's case swapped", path: () => `/f/${swapCase(token)}.ics` },
      { name: "a segment after", path: () => `/f/${token}.ics/extra` },
      { name: "a segment before", path: () => `/f/extra/${token}.ics` },
      { name: "no token", path: () => "/f/.ics" },
    ])("gets the app's plain 404 for $name, to GET and HEAD", async ({ path }) => {
      for (const method of ["GET", "HEAD"]) {
        expect(await observable(await app.request(path(), { method }))).toEqual(
          await plainNotFound(method),
        );
      }
    });

    it("gets the plain 404 at the old URL once the student makes a new one", async () => {
      await connectCanvas(userId);
      network.canvas.items = [assignment(1)];
      await syncUser(userId);

      const oldPath = `/f/${token}.ics`;
      const newPath = await newFeed();
      expect(newPath).not.toBe(oldPath);
      expect(await observable(await app.request(oldPath))).toEqual(await plainNotFound());
      expect(await feedEventIds(newPath)).toEqual(["assignment-1"]);
      expect(await (await getFeedUrl()).json()).toEqual({ path: newPath });
    });
  });
});

function swapCase(text: string): string {
  return text.replace(/[a-z]/gi, (char) =>
    char === char.toLowerCase() ? char.toUpperCase() : char.toLowerCase(),
  );
}
