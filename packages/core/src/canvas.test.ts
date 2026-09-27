import { readFileSync } from "node:fs";
import { afterEach, describe, expect, it, vi } from "vitest";
import {
  canvasFeedUrl,
  fetchCanvasFeed,
  fetchPlannerItems,
  normalizePlannerItems,
  verifyCanvasToken,
  type PlannerItem,
} from "./canvas.js";

// A real /api/v1/planner/items response from canvas.sfu.ca, cut down to a few
// items of each type. The student's name, user id, and the signed tokens on
// course images are replaced; everything else is as Canvas sent it.
const items = JSON.parse(
  readFileSync(new URL("../fixtures/planner-items.json", import.meta.url), "utf8"),
) as PlannerItem[];

describe("normalizePlannerItems", () => {
  it("keeps assignments, discussions, quizzes, and calendar events, and drops announcements", () => {
    expect(normalizePlannerItems(items)).toEqual([
      // The three announcements at the top of the fixture are gone.
      {
        id: "assignment-214996",
        kind: "assignment",
        title: "Assignment 1 - AI Today and Where It’s Going",
        course: "CMPT310 D200 Introduction to Artificial Intelligence",
        url: "https://canvas.sfu.ca/courses/18634/assignments/214996",
        start: "2026-09-29T06:59:59Z",
        end: null,
        allDay: false,
      },
      // A graded discussion: Canvas calls the type "discussion_topic".
      {
        id: "discussion-262671",
        kind: "discussion",
        title: "[Weekly Activity 2.2] Exploring URDF and Robot Modeling",
        course: "CMPT310 D200 Introduction to Artificial Intelligence",
        url: "https://canvas.sfu.ca/courses/18634/discussion_topics/262671",
        start: "2026-09-30T06:59:59Z",
        end: null,
        allDay: false,
      },
      {
        id: "assignment-232691",
        kind: "assignment",
        title: "Assignment 1",
        course: "CMPT307 D200 Data Structures and Algorithms",
        url: "https://canvas.sfu.ca/courses/18618/assignments/232691",
        start: "2026-10-04T06:59:59Z",
        end: null,
        allDay: false,
      },
      {
        id: "quiz-70610",
        kind: "quiz",
        title: "Quiz 1 - Modules 1-3,  Images/Multiple Choice",
        course: "ARCH301 OL01 Ancient Visual Art",
        url: "https://canvas.sfu.ca/courses/15816/quizzes/70610",
        start: "2026-10-06T06:59:59Z",
        end: null,
        allDay: false,
      },
      // Personal events: html_url is already a full URL, and the context is
      // the student (see the TODO in canvas.ts).
      {
        id: "event-76332",
        kind: "event",
        title: "Test Timed Event.",
        course: "Alex Chen",
        url: "https://canvas.sfu.ca/calendar?event_id=76332&include_contexts=user_1234567",
        start: "2026-10-07T21:00:00Z",
        end: "2026-10-07T22:00:00Z",
        allDay: false,
      },
      // Midnight Oct 21 in Vancouver, which Canvas also saves as the end.
      {
        id: "event-76333",
        kind: "event",
        title: "Test All-Day Event.",
        course: "Alex Chen",
        url: "https://canvas.sfu.ca/calendar?event_id=76333&include_contexts=user_1234567",
        start: "2026-10-21T07:00:00Z",
        end: "2026-10-21T07:00:00Z",
        allDay: true,
      },
    ]);
  });

  it("takes the due date from plannable_date, which includes the student's extension", () => {
    // plannable.due_at is the date the whole class sees. Give this student
    // two extra days, which Canvas reports only in plannable_date.
    const assignment = items.find((item) => item.plannable_id === 214996)!;
    const extended = { ...assignment, plannable_date: "2026-10-01T06:59:59Z" };
    expect(normalizePlannerItems([extended])).toMatchObject([
      { start: "2026-10-01T06:59:59Z" },
    ]);
  });
});

// Stands in for the network: answers each request with the next response.
function stubFetch(...responses: Response[]) {
  const fetchMock = vi.fn<typeof fetch>(async () => responses.shift()!);
  vi.stubGlobal("fetch", fetchMock);
  return fetchMock;
}

afterEach(() => {
  vi.unstubAllGlobals();
});

function page(body: unknown[], next?: string): Response {
  return Response.json(body, {
    headers: next ? { link: `<${next}>; rel="next"` } : {},
  });
}

const START = new Date("2026-09-01T00:00:00Z");
const END = new Date("2026-12-31T00:00:00Z");
const FEED = "https://canvas.sfu.ca/feeds/calendars/user_AbC123.ics";

describe("fetchPlannerItems", () => {
  it("follows next links on canvas.sfu.ca, with the token and no redirects on every page", async () => {
    const fetchMock = stubFetch(
      page(items.slice(0, 2), "https://canvas.sfu.ca/api/v1/planner/items?page=2"),
      page(items.slice(2)),
    );
    expect(await fetchPlannerItems("t0ken", START, END)).toEqual(items);
    expect(fetchMock.mock.calls).toEqual([
      [
        expect.stringMatching(/^https:\/\/canvas\.sfu\.ca\/api\/v1\/planner\/items\?/),
        { headers: { Authorization: "Bearer t0ken" }, redirect: "error" },
      ],
      [
        "https://canvas.sfu.ca/api/v1/planner/items?page=2",
        { headers: { Authorization: "Bearer t0ken" }, redirect: "error" },
      ],
    ]);
  });

  // The next page's URL comes from Canvas's response, not from Calo.
  it.each([
    "https://evil.example/api/v1/planner/items?page=2",
    "https://canvas.sfu.ca.evil.example/api/v1/planner/items?page=2",
    "https://canvas.sfu.ca@evil.example/api/v1/planner/items?page=2",
    "http://canvas.sfu.ca/api/v1/planner/items?page=2",
  ])("refuses to send the token to a next link at %s", async (next) => {
    const fetchMock = stubFetch(page(items, next), page([]));
    await expect(fetchPlannerItems("t0ken", START, END)).rejects.toThrow(
      "Refusing to send the Canvas token",
    );
    expect(fetchMock).toHaveBeenCalledOnce();
  });
});

describe("verifyCanvasToken", () => {
  it("asks canvas.sfu.ca who the token belongs to, without following redirects", async () => {
    const fetchMock = stubFetch(Response.json({ id: 1 }));
    await verifyCanvasToken("t0ken");
    expect(fetchMock).toHaveBeenCalledWith("https://canvas.sfu.ca/api/v1/users/self", {
      headers: { Authorization: "Bearer t0ken" },
      redirect: "error",
    });
  });
});

describe("canvasFeedUrl", () => {
  it.each([
    [FEED, FEED],
    ["HTTPS://CANVAS.SFU.CA/feeds/calendars/user_AbC123.ics", FEED],
    [`${FEED}?foo=1#bar`, FEED],
  ])("accepts %s", (input, expected) => {
    expect(canvasFeedUrl(input)).toBe(expected);
  });

  it.each([
    "https://evil.example/feeds/calendars/user_AbC123.ics",
    "https://canvas.sfu.ca.evil.example/feeds/calendars/user_AbC123.ics",
    "https://canvas.sfu.ca@evil.example/feeds/calendars/user_AbC123.ics",
    "http://canvas.sfu.ca/feeds/calendars/user_AbC123.ics",
    "https://canvas.sfu.ca:8443/feeds/calendars/user_AbC123.ics",
    "https://canvas.sfu.ca/feeds/calendars/course_AbC123.ics",
    "https://canvas.sfu.ca/courses/18634",
    "not a url",
  ])("rejects %s", (input) => {
    expect(canvasFeedUrl(input)).toBeNull();
  });
});

describe("fetchCanvasFeed", () => {
  it("fetches the feed without following redirects", async () => {
    const fetchMock = stubFetch(new Response("BEGIN:VCALENDAR"));
    expect(await fetchCanvasFeed(FEED)).toBe("BEGIN:VCALENDAR");
    expect(fetchMock).toHaveBeenCalledWith(FEED, { redirect: "error" });
  });

  it("refuses a URL that isn't a canvas.sfu.ca feed, without fetching it", async () => {
    const fetchMock = stubFetch();
    await expect(
      fetchCanvasFeed("https://evil.example/feeds/calendars/user_AbC123.ics"),
    ).rejects.toThrow("Refusing to fetch a Canvas feed");
    expect(fetchMock).not.toHaveBeenCalled();
  });
});
