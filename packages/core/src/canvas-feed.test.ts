import { readFileSync } from "node:fs";
import { describe, expect, it } from "vitest";
import { parseCanvasFeed } from "./canvas-feed.js";

// Written to match what Canvas's serializer (canvas-lms
// CalendarEvent::IcalEvent#to_ics, via the icalendar-ruby gem) emits: its
// property order, escaping, 75-octet folds, and CRLF line endings.
const fixture = readFileSync(
  new URL("../fixtures/canvas-feed.ics", import.meta.url),
  "utf8",
);

const calendarUrl = (context: string, anchor: string) =>
  `https://canvas.sfu.ca/calendar?include_contexts=${context}&month=10&year=2026#${anchor}`;

// A minimal feed with one VEVENT, for the failure cases.
const feed = (...props: string[]) =>
  ["BEGIN:VCALENDAR", "BEGIN:VEVENT", ...props, "END:VEVENT", "END:VCALENDAR", ""].join(
    "\r\n",
  );

describe("parseCanvasFeed", () => {
  const { events, ambiguousIds } = parseCanvasFeed(fixture);

  it("reads each kind of item Canvas exports", () => {
    expect(events).toEqual([
      // Due at 11:59 PM, so Canvas exports only the date.
      {
        id: "assignment-1204417",
        kind: "assignment",
        title: "Assignment 2: Linked Lists",
        course: "CMPT 225 D100",
        url: calendarUrl("course_62841", "assignment_1204417"),
        start: "2026-10-02T00:00:00Z",
        end: null,
        allDay: true,
      },
      // Brackets, a comma, a semicolon, and a literal backslash-n in the title.
      {
        id: "assignment-1204460",
        kind: "assignment",
        title: String.raw`Lab 4 [optional]: stacks, queues; printf("\n")`,
        course: "CMPT 225 D100",
        url: calendarUrl("course_62841", "assignment_1204460"),
        start: "2026-10-05T00:00:00Z",
        end: null,
        allDay: true,
      },
      // A quiz: the feed only knows it as an assignment.
      {
        id: "assignment-1204502",
        kind: "assignment",
        title: "Quiz 3: Taylor Series",
        course: "MATH 152 D100",
        url: calendarUrl("course_62907", "assignment_1204502"),
        start: "2026-10-06T17:30:00Z",
        end: null,
        allDay: false,
      },
      // Folded mid-summary, with multi-byte characters.
      {
        id: "assignment-1205120",
        kind: "assignment",
        title: "Lab Report 2 – Projectile Motion: Résumé & Uncertainty Analysis 🚀",
        course: "PHYS 140 D100",
        url: calendarUrl("course_63015", "assignment_1205120"),
        start: "2026-10-08T21:30:00Z",
        end: null,
        allDay: false,
      },
      // Section override: the id comes from the URL, not the override's UID.
      {
        id: "assignment-1204588",
        kind: "assignment",
        title: "Midterm Reflection (D102)",
        course: "MATH 152 D100",
        url: calendarUrl("course_62907", "assignment_1204588"),
        start: "2026-10-10T00:00:00Z",
        end: null,
        allDay: false,
      },
      // Personal event: no course suffix.
      {
        id: "event-3311002",
        kind: "event",
        title: "Study group",
        course: "",
        url: calendarUrl("user_1234567", "calendar_event_3311002"),
        start: "2026-10-07T23:00:00Z",
        end: "2026-10-08T00:30:00Z",
        allDay: false,
      },
      {
        id: "event-3308871",
        kind: "event",
        title: "No lecture – Thanksgiving",
        course: "CMPT 225 D100",
        url: calendarUrl("course_62841", "calendar_event_3308871"),
        start: "2026-10-12T00:00:00Z",
        end: "2026-10-12T00:00:00Z",
        allDay: true,
      },
      {
        id: "event-3310245",
        kind: "event",
        title: "Midterm 1",
        course: "PHYS 140 D100",
        url: calendarUrl("course_63015", "calendar_event_3310245"),
        start: "2026-10-15T01:30:00Z",
        end: "2026-10-15T03:20:00Z",
        allDay: false,
      },
    ]);
  });

  it("leaves out both items of an id collision and keeps the rest", () => {
    // Two overridden checkpoints of one discussion both point at its
    // assignment, so they'd share an id.
    expect(ambiguousIds).toEqual(["assignment-1205411"]);
    expect(events.map((e) => e.id)).not.toContain("assignment-1205411");
    expect(events).toHaveLength(8);
  });

  it("throws on a time that isn't UTC", () => {
    const ics = feed(
      "UID:event-assignment-1",
      "DTSTART;TZID=America/Vancouver:20261002T235900",
      "SUMMARY:Assignment [CMPT 225 D100]",
      "URL:https://canvas.sfu.ca/calendar#assignment_1",
    );
    expect(() => parseCanvasFeed(ics)).toThrow(/unexpected date/);
  });

  it("throws on an override whose URL doesn't name the assignment", () => {
    const ics = feed(
      "UID:event-assignment-override-7",
      "DTSTART:20261003T065900Z",
      "SUMMARY:Assignment (D102) [CMPT 225 D100]",
      "URL:https://canvas.sfu.ca/calendar?include_contexts=course_1",
    );
    expect(() => parseCanvasFeed(ics)).toThrow(/no assignment id/);
  });
});
