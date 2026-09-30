import { afterEach, describe, expect, it, vi } from "vitest";
import type { CaloEvent } from "./event.js";
import {
  createGoogleCalendar,
  deleteGoogleEvent,
  googleCalendarExists,
  GoogleError,
  refreshGoogleAccessToken,
  toGoogleEvent,
  upsertGoogleEvent,
  type GoogleClient,
} from "./google.js";

const deadline: CaloEvent = {
  id: "assignment-1204417",
  kind: "assignment",
  title: "Assignment 2",
  course: "CMPT 225 D100",
  url: "https://canvas.sfu.ca/courses/62841/assignments/1204417",
  start: "2026-10-03T06:59:59Z", // 11:59:59 PM Oct 2 in Vancouver
  end: null,
  allDay: false,
};

const midterm: CaloEvent = {
  id: "event-3310245",
  kind: "event",
  title: "Midterm 1",
  course: "PHYS 140 D100",
  url: "https://canvas.sfu.ca/calendar?event_id=3310245",
  start: "2026-10-15T01:30:00Z",
  end: "2026-10-15T03:20:00Z",
  allDay: false,
};

const holiday: CaloEvent = {
  id: "event-3308871",
  kind: "event",
  title: "No lecture",
  course: "CMPT 225 D100",
  url: "https://canvas.sfu.ca/calendar?event_id=3308871",
  start: "2026-10-12T07:00:00Z", // midnight Oct 12 in Vancouver
  end: "2026-10-12T07:00:00Z",
  allDay: true,
};

describe("toGoogleEvent", () => {
  it("makes a deadline an instant at its due time", () => {
    expect(toGoogleEvent(deadline)).toEqual({
      id: "61737369676e6d656e742d31323034343137",
      summary: "Assignment 2 [CMPT 225 D100]",
      description: "https://canvas.sfu.ca/courses/62841/assignments/1204417",
      start: { dateTime: "2026-10-03T06:59:59Z" },
      end: { dateTime: "2026-10-03T06:59:59Z" },
      status: "confirmed",
    });
  });

  it("keeps a timed event's end", () => {
    expect(toGoogleEvent(midterm)).toMatchObject({
      start: { dateTime: "2026-10-15T01:30:00Z" },
      end: { dateTime: "2026-10-15T03:20:00Z" },
    });
  });

  it("ends an all-day event the next day, since Google's end date is exclusive", () => {
    expect(toGoogleEvent(holiday)).toMatchObject({
      start: { date: "2026-10-12" },
      end: { date: "2026-10-13" },
    });
  });

  it("gives every Calo id a different Google id that Google accepts", () => {
    const ids = ["quiz-1", "quiz-12", "assignment-1204417", "discussion-99"].map(
      (id) => toGoogleEvent({ ...deadline, id }).id,
    );
    expect(new Set(ids).size).toBe(ids.length);
    for (const id of ids) {
      expect(id).toMatch(/^[a-v0-9]{5,1024}$/);
    }
  });
});

// Stands in for Google: answers each request with the next response.
function stubFetch(...responses: Response[]) {
  const fetchMock = vi.fn<typeof fetch>(async () => responses.shift()!);
  vi.stubGlobal("fetch", fetchMock);
  return fetchMock;
}

afterEach(() => {
  vi.unstubAllGlobals();
});

// The method, URL, and JSON body of each request made.
function requests(fetchMock: ReturnType<typeof stubFetch>) {
  return fetchMock.mock.calls.map(([url, init]) => [
    init?.method,
    url,
    init?.body && JSON.parse(init.body as string),
  ]);
}

// Errors in the shapes Google sends them. The token endpoint names the error
// in a string; the Calendar API puts a reason inside an object.
function tokenError(status: number, error: string): Response {
  return Response.json({ error, error_description: "..." }, { status });
}

function calendarError(status: number, reason: string): Response {
  return Response.json(
    { error: { code: status, message: "...", errors: [{ domain: "global", reason, message: "..." }] } },
    { status },
  );
}

// What Google's front end sends for a 502 or 503, in place of JSON.
function htmlError(status: number): Response {
  return new Response(
    `<!DOCTYPE html>
<html lang=en>
  <meta charset=utf-8>
  <title>Error ${status} (Server Error)!!1</title>
  <p><b>${status}.</b> <ins>That’s an error.</ins>`,
    { status, headers: { "Content-Type": "text/html; charset=UTF-8" } },
  );
}

const CLIENT: GoogleClient = {
  id: "client-id",
  secret: "client-secret",
  redirectUri: "http://localhost:3000/api/google/callback",
};
const CALENDAR_ID = "c_0a1b2c3d4e5f@group.calendar.google.com";
const EVENTS = `https://www.googleapis.com/calendar/v3/calendars/${encodeURIComponent(CALENDAR_ID)}/events`;

describe("upsertGoogleEvent", () => {
  // Google answers 409 when the event is there already, or when Calo deleted
  // it and Google is keeping its id.
  it("updates the event in place when its id is taken", async () => {
    const fetchMock = stubFetch(calendarError(409, "duplicate"), Response.json({}));
    await upsertGoogleEvent("access", CALENDAR_ID, deadline);
    const body = toGoogleEvent(deadline);
    expect(requests(fetchMock)).toEqual([
      ["POST", EVENTS, body],
      ["PUT", `${EVENTS}/${body.id}`, body],
    ]);
  });

  it("throws on any other error, without trying an update", async () => {
    const fetchMock = stubFetch(calendarError(403, "rateLimitExceeded"));
    await expect(upsertGoogleEvent("access", CALENDAR_ID, deadline)).rejects.toMatchObject({
      status: 403,
      reason: "rateLimitExceeded",
    });
    expect(fetchMock).toHaveBeenCalledOnce();
  });
});

describe("deleteGoogleEvent", () => {
  // If the two ids ever differed, every delete would 404, which counts as
  // already deleted, and items removed from Canvas would stay on the calendar.
  it("deletes the Google event that upsertGoogleEvent made for the same Calo id", async () => {
    const fetchMock = stubFetch(new Response(null, { status: 204 }));
    await deleteGoogleEvent("access", CALENDAR_ID, deadline.id);
    expect(requests(fetchMock)).toEqual([
      ["DELETE", `${EVENTS}/${toGoogleEvent(deadline).id}`, undefined],
    ]);
  });

  // 410 is what Google answers for an event that was already deleted, say by
  // the student in Google Calendar.
  it.each([
    [404, "notFound"],
    [410, "deleted"],
  ])("counts a %i as already deleted", async (status, reason) => {
    stubFetch(calendarError(status, reason));
    await expect(deleteGoogleEvent("access", CALENDAR_ID, deadline.id)).resolves.toBeUndefined();
  });

  it("throws on a server error", async () => {
    stubFetch(calendarError(500, "backendError"));
    await expect(deleteGoogleEvent("access", CALENDAR_ID, deadline.id)).rejects.toMatchObject({
      status: 500,
    });
  });
});

describe("googleCalendarExists", () => {
  it.each([
    [404, "notFound"],
    [410, "deleted"],
  ])("is false after a %i", async (status, reason) => {
    stubFetch(calendarError(status, reason));
    expect(await googleCalendarExists("access", CALENDAR_ID)).toBe(false);
  });

  // Otherwise a rejected access token would look like a deleted calendar, and
  // push would make a new, empty one.
  it("throws when Google rejects the access token", async () => {
    stubFetch(calendarError(401, "authError"));
    await expect(googleCalendarExists("access", CALENDAR_ID)).rejects.toMatchObject({
      status: 401,
      reason: "authError",
    });
  });
});

describe("refreshGoogleAccessToken", () => {
  it("returns null once Google stops accepting the refresh token", async () => {
    stubFetch(tokenError(400, "invalid_grant"));
    expect(await refreshGoogleAccessToken(CLIENT, "refresh")).toBeNull();
  });

  // Neither means the student's token is dead: invalid_client is a problem
  // with Calo's own OAuth client, and an HTML page is Google having an outage.
  it.each([
    ["invalid_client", tokenError(401, "invalid_client"), 401, "invalid_client"],
    ["an HTML error page", htmlError(502), 502, ""],
  ])("throws for %s", async (_, response, status, reason) => {
    stubFetch(response);
    await expect(refreshGoogleAccessToken(CLIENT, "refresh")).rejects.toMatchObject({
      status,
      reason,
    });
  });
});

describe("GoogleError", () => {
  // The token endpoint's shape is covered by the refreshGoogleAccessToken tests.
  it.each([
    ["the Calendar API's JSON", calendarError(403, "rateLimitExceeded"), 403, "rateLimitExceeded"],
    [
      "JSON with no reason in it",
      Response.json({ error: { code: 500, message: "Backend Error" } }, { status: 500 }),
      500,
      "",
    ],
    ["an HTML page from Google's front end", htmlError(502), 502, ""],
    ["an empty body", new Response(null, { status: 503 }), 503, ""],
  ])("keeps the status and reads the reason from %s", async (_, response, status, reason) => {
    stubFetch(response);
    const err = await createGoogleCalendar("access").catch((e: unknown) => e);
    // A GoogleError, not a SyntaxError from parsing HTML as JSON.
    expect(err).toBeInstanceOf(GoogleError);
    expect(err).toMatchObject({ status, reason });
  });
});
