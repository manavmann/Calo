import { CanvasError, normalizePlannerItems, type PlannerItem } from "@calo/core";
import { eq, sql } from "drizzle-orm";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { db } from "./db.ts";
import { fakeNetwork } from "./fake-network.ts";
import { syncedEvents } from "./schema.ts";
import { contentHash } from "./sync-diff.ts";
import { syncUser } from "./sync.ts";
import { assignment, connectCanvas, daysFromNow, newUser, syncedRows } from "./test-fixtures.ts";

let network: ReturnType<typeof fakeNetwork>;

beforeEach(() => {
  network = fakeNetwork();
});

afterEach(() => {
  vi.unstubAllGlobals();
});

describe("syncUser", () => {
  it("stores every item on the first sync, then writes nothing while Canvas is unchanged", async () => {
    const { id } = await newUser();
    await connectCanvas(id);
    network.canvas.items = [assignment(1), assignment(2, 14)];

    expect(await syncUser(id)).toEqual({
      added: ["assignment-1", "assignment-2"],
      changed: [],
      deleted: [],
    });
    expect((await syncedRows(id)).get("assignment-1")).toMatchObject({
      kind: "assignment",
      title: "Assignment 1",
      course: "CMPT307 D200 Data Structures and Algorithms",
      url: "https://canvas.sfu.ca/courses/18618/assignments/1",
      start: daysFromNow(7),
      end: null,
      allDay: false,
      googleHash: null,
      deletedAt: null,
    });

    expect(await syncUser(id)).toEqual({ added: [], changed: [], deleted: [] });
  });

  // Every column changes, so a wrong column name in the upsert's excluded.*
  // shows up here. Only running against real Postgres can catch that.
  it("updates every column of an item that changed on Canvas", async () => {
    const { id } = await newUser();
    await connectCanvas(id);
    const before: PlannerItem = {
      plannable_type: "calendar_event",
      plannable_id: 76332,
      plannable_date: daysFromNow(3).toISOString(),
      html_url: "https://canvas.sfu.ca/calendar?event_id=76332",
      context_name: "CMPT307 D200 Data Structures and Algorithms",
      plannable: { title: "Midterm", end_at: daysFromNow(3.1).toISOString(), all_day: false },
    };
    network.canvas.items = [before];
    await syncUser(id);

    const after: PlannerItem = {
      ...before,
      plannable_date: daysFromNow(5).toISOString(),
      html_url: "https://canvas.sfu.ca/calendar?event_id=76332&include_contexts=course_18618",
      context_name: "CMPT307 D200 Data Structures & Algorithms",
      plannable: { title: "Midterm (moved)", end_at: daysFromNow(6).toISOString(), all_day: true },
    };
    network.canvas.items = [after];
    expect(await syncUser(id)).toEqual({ added: [], changed: ["event-76332"], deleted: [] });
    expect((await syncedRows(id)).get("event-76332")).toMatchObject({
      title: "Midterm (moved)",
      course: "CMPT307 D200 Data Structures & Algorithms",
      url: "https://canvas.sfu.ca/calendar?event_id=76332&include_contexts=course_18618",
      start: daysFromNow(5),
      end: daysFromNow(6),
      allDay: true,
      contentHash: contentHash(normalizePlannerItems([after])[0]!),
    });
  });

  it("tombstones an item gone from Canvas, keeping its google_hash, and revives it when it's back", async () => {
    const { id } = await newUser();
    await connectCanvas(id);
    network.canvas.items = [assignment(1), assignment(2)];
    await syncUser(id);
    // As a push would have.
    await db
      .update(syncedEvents)
      .set({ googleHash: sql`${syncedEvents.contentHash}` })
      .where(eq(syncedEvents.userId, id));

    network.canvas.items = [assignment(2)];
    expect(await syncUser(id)).toEqual({ added: [], changed: [], deleted: ["assignment-1"] });
    const gone = (await syncedRows(id)).get("assignment-1")!;
    expect(gone.deletedAt).not.toBeNull();
    // Still set, so the next push knows the event is in Google and deletes it.
    expect(gone.googleHash).toBe(gone.contentHash);

    network.canvas.items = [assignment(1), assignment(2)];
    expect(await syncUser(id)).toEqual({ added: ["assignment-1"], changed: [], deleted: [] });
    expect((await syncedRows(id)).get("assignment-1")!.deletedAt).toBeNull();
  });

  it("writes nothing when Canvas errors, so a failed pull can't delete every event", async () => {
    const { id } = await newUser();
    await connectCanvas(id);
    network.canvas.items = [assignment(1)];
    await syncUser(id);

    // As when the student deletes their access token on Canvas.
    network.failNext(
      ({ url }) => url.startsWith("https://canvas.sfu.ca/"),
      new Response(null, { status: 401, statusText: "Unauthorized" }),
    );
    await expect(syncUser(id)).rejects.toThrow(CanvasError);
    expect((await syncedRows(id)).get("assignment-1")!.deletedAt).toBeNull();
  });

  // Canvas ids are shared: everyone in a course sees the same assignment-1.
  it("never touches a classmate's row for the same Canvas item", async () => {
    const alice = await newUser();
    const bob = await newUser();
    await connectCanvas(alice.id);
    await connectCanvas(bob.id);
    network.canvas.items = [assignment(1)];
    await syncUser(alice.id);
    await syncUser(bob.id);

    // Alice gets an extension.
    network.canvas.items = [assignment(1, 9)];
    await syncUser(alice.id);
    expect((await syncedRows(bob.id)).get("assignment-1")!.start).toEqual(daysFromNow(7));

    // Then the assignment is taken off Alice's list alone.
    network.canvas.items = [];
    await syncUser(alice.id);
    expect((await syncedRows(alice.id)).get("assignment-1")!.deletedAt).not.toBeNull();
    expect((await syncedRows(bob.id)).get("assignment-1")!.deletedAt).toBeNull();
  });

  it("doesn't tombstone an item the feed couldn't read", async () => {
    const { id } = await newUser();
    await connectCanvas(id, "feed", "https://canvas.sfu.ca/feeds/calendars/user_AbC123.ics");
    const url = "https://canvas.sfu.ca/calendar?include_contexts=course_62841#assignment_1204417";
    network.canvas.feed = feed(vevent("event-assignment-1204417", url, daysFromNow(7)));
    expect((await syncUser(id)).added).toEqual(["assignment-1204417"]);

    // An override that resolves to the same id: the feed can't say which is
    // the student's due date, so the assignment is missing from the pull.
    network.canvas.feed = feed(
      vevent("event-assignment-1204417", url, daysFromNow(7)),
      vevent("event-assignment-override-88213", url, daysFromNow(9)),
    );
    expect(await syncUser(id)).toEqual({ added: [], changed: [], deleted: [] });
    expect((await syncedRows(id)).get("assignment-1204417")!.deletedAt).toBeNull();
  });
});

function feed(...vevents: string[]): string {
  return ["BEGIN:VCALENDAR", "VERSION:2.0", ...vevents, "END:VCALENDAR"].join("\r\n");
}

// A timed assignment, as Canvas's feed writes one.
function vevent(uid: string, url: string, due: Date): string {
  const time = due.toISOString().replace(/[-:]|\.\d{3}/g, "");
  return [
    "BEGIN:VEVENT",
    `UID:${uid}`,
    `DTSTART:${time}`,
    `DTEND:${time}`,
    "SUMMARY:Assignment 2 [CMPT 225 D100]",
    `URL:${url}`,
    "END:VEVENT",
  ].join("\r\n");
}
