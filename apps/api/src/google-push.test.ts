import type { PlannerItem } from "@calo/core";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { calendarError, calendarUrl, fakeNetwork, GOOGLE_TOKEN_URL } from "./fake-network.ts";
import { pushToGoogle } from "./google-push.ts";
import { syncUser } from "./sync.ts";
import {
  assignment,
  connectCanvas,
  connectGoogle,
  daysFromNow,
  googleConnectionRow,
  newUser,
  REFRESH_TOKEN,
  syncedRows,
} from "./test-fixtures.ts";

let network: ReturnType<typeof fakeNetwork>;
let userId: string;

beforeEach(async () => {
  network = fakeNetwork();
  userId = (await newUser()).id;
  await connectCanvas(userId);
});

afterEach(() => {
  vi.unstubAllGlobals();
});

// Canvas now has these items, and sync has run.
async function onCanvas(...items: PlannerItem[]) {
  network.canvas.items = items;
  await syncUser(userId);
}

// Push goes through rows in whatever order Postgres returns them, so the ids
// are sorted to compare.
async function push() {
  const result = await pushToGoogle(userId);
  return result.status === "pushed"
    ? { ...result, written: result.written.toSorted(), removed: result.removed.toSorted() }
    : result;
}

async function calendarId(): Promise<string> {
  return (await googleConnectionRow(userId))!.calendarId!;
}

// The events google_hash says are in Google. Should match what's live on the
// fake calendar after every push.
async function recordedInGoogle(): Promise<string[]> {
  return [...(await syncedRows(userId)).values()]
    .filter((row) => row.googleHash !== null)
    .map((row) => row.eventId)
    .sort();
}

describe("pushToGoogle", () => {
  it("does nothing for a student who hasn't connected Google", async () => {
    await onCanvas(assignment(1));
    expect(await push()).toEqual({ status: "not connected" });
    expect(network.googleRequests()).toEqual([]);
  });

  it("doesn't call Google while the connection needs reconnecting", async () => {
    await connectGoogle(userId, new Date());
    await onCanvas(assignment(1));
    expect(await push()).toEqual({ status: "needs reconnect" });
    expect(network.googleRequests()).toEqual([]);
  });

  it("marks the connection revoked when Google stops accepting the refresh token", async () => {
    await connectGoogle(userId);
    await onCanvas(assignment(1));
    // As when the student removes Calo's access in their Google account.
    network.google.revokedTokens.add(REFRESH_TOKEN);

    expect(await push()).toEqual({ status: "needs reconnect" });
    expect((await googleConnectionRow(userId))!.revokedAt).not.toBeNull();
    // Still pending, so reconnecting catches the calendar up.
    expect(await recordedInGoogle()).toEqual([]);
  });

  // Otherwise an outage at Google would make every student reconnect.
  it("stays connected when Google's token endpoint sends an error page", async () => {
    await connectGoogle(userId);
    await onCanvas(assignment(1));
    network.failNext(
      ({ url }) => url === GOOGLE_TOKEN_URL,
      new Response("<!DOCTYPE html><title>Error 502 (Server Error)!!1</title>", { status: 502 }),
    );

    await expect(push()).rejects.toMatchObject({ status: 502, reason: "" });
    expect((await googleConnectionRow(userId))!.revokedAt).toBeNull();
  });

  it("makes the calendar on the first push and writes every live event to it", async () => {
    await connectGoogle(userId);
    await onCanvas(assignment(1), assignment(2), assignment(3));
    // Gone before it ever reached Google, so there's nothing to delete there.
    await onCanvas(assignment(1), assignment(2));

    expect(await push()).toEqual({
      status: "pushed",
      newCalendar: true,
      written: ["assignment-1", "assignment-2"],
      removed: [],
    });
    expect(network.google.liveEvents(await calendarId())).toEqual(["assignment-1", "assignment-2"]);
    expect(await recordedInGoogle()).toEqual(["assignment-1", "assignment-2"]);
    expect(network.googleRequests().filter(({ method }) => method === "DELETE")).toEqual([]);
  });

  it("only refreshes the token and checks the calendar when nothing has changed", async () => {
    await connectGoogle(userId);
    await onCanvas(assignment(1));
    await push();
    network.requests.length = 0;

    expect(await push()).toEqual({ status: "pushed", newCalendar: false, written: [], removed: [] });
    expect(network.googleRequests().map(({ method, url }) => `${method} ${url}`)).toEqual([
      `POST ${GOOGLE_TOKEN_URL}`,
      `GET ${calendarUrl(await calendarId())}`,
    ]);
  });

  it("removes events deleted on Canvas, including one the student already deleted in Google", async () => {
    await connectGoogle(userId);
    await onCanvas(assignment(1), assignment(2));
    await push();
    network.google.deleteEvent(await calendarId(), "assignment-2");
    await onCanvas();

    expect(await push()).toEqual({
      status: "pushed",
      newCalendar: false,
      written: [],
      removed: ["assignment-1", "assignment-2"],
    });
    // Google answers 410 for the one that was already deleted, which counts as done.
    const deletes = network.googleRequests().filter(({ method }) => method === "DELETE");
    expect(deletes.map(({ status }) => status).sort()).toEqual([204, 410]);
    expect(network.google.liveEvents(await calendarId())).toEqual([]);
    expect(await recordedInGoogle()).toEqual([]);
  });

  it("makes a new calendar when the student deleted Calo's, and rewrites every live event to it", async () => {
    await connectGoogle(userId);
    await onCanvas(assignment(1), assignment(2), assignment(3));
    await push();
    const deleted = await calendarId();
    await onCanvas(assignment(1), assignment(2));
    // As when the student deletes the calendar in Google Calendar.
    network.google.calendars.delete(deleted);
    network.requests.length = 0;

    expect(await push()).toEqual({
      status: "pushed",
      newCalendar: true,
      written: ["assignment-1", "assignment-2"],
      removed: [],
    });
    expect(await calendarId()).not.toBe(deleted);
    expect(network.google.liveEvents(await calendarId())).toEqual(["assignment-1", "assignment-2"]);
    // assignment-3 went with the old calendar.
    expect(network.googleRequests().filter(({ method }) => method === "DELETE")).toEqual([]);
    expect(await recordedInGoogle()).toEqual(["assignment-1", "assignment-2"]);
  });

  it("picks up where it stopped when Google fails partway through", async () => {
    await connectGoogle(userId);
    await onCanvas(assignment(1), assignment(2), assignment(3));
    network.failNext(
      ({ method, body }) => method === "POST" && body?.summary?.startsWith("Assignment 2 "),
      calendarError(500, "backendError"),
    );

    await expect(push()).rejects.toMatchObject({ status: 500 });
    // Whatever got through before the failure is recorded, and nothing else.
    const through = network.google.liveEvents(await calendarId());
    expect(through).not.toContain("assignment-2");
    expect(await recordedInGoogle()).toEqual(through);

    expect(await push()).toEqual({
      status: "pushed",
      newCalendar: false,
      written: ["assignment-1", "assignment-2", "assignment-3"].filter((id) => !through.includes(id)),
      removed: [],
    });
    expect(network.google.liveEvents(await calendarId())).toEqual([
      "assignment-1",
      "assignment-2",
      "assignment-3",
    ]);
  });

  it("keeps Google in step as an item is posted, extended, removed, and restored on Canvas", async () => {
    await connectGoogle(userId);
    await onCanvas(assignment(1));
    await push();
    const calendar = await calendarId();

    await onCanvas(assignment(1, 9));
    expect(await push()).toMatchObject({ written: ["assignment-1"], removed: [] });
    expect(network.google.event(calendar, "assignment-1")).toMatchObject({
      start: { dateTime: daysFromNow(9).toISOString() },
    });

    await onCanvas();
    expect(await push()).toMatchObject({ written: [], removed: ["assignment-1"] });
    expect(network.google.liveEvents(calendar)).toEqual([]);

    network.requests.length = 0;
    await onCanvas(assignment(1, 9));
    expect(await push()).toMatchObject({ written: ["assignment-1"], removed: [] });
    // Google kept the deleted event's id, so the insert is refused and the
    // update, with status "confirmed", brings it back.
    const writes = network.googleRequests().filter(({ url }) => url.includes("/events"));
    expect(writes.map(({ method, status, body }) => [method, status, body.status])).toEqual([
      ["POST", 409, "confirmed"],
      ["PUT", 200, "confirmed"],
    ]);
    expect(network.google.liveEvents(calendar)).toEqual(["assignment-1"]);
  });
});
