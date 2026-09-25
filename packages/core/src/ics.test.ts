import { describe, expect, it } from "vitest";
import type { CaloEvent } from "./event.js";
import { generateIcs } from "./ics.js";

const now = new Date("2026-09-24T17:00:00Z");

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

describe("generateIcs", () => {
  it("writes deadlines, timed events, and all-day events", () => {
    expect(generateIcs([deadline, midterm, holiday], now)).toBe(
      [
        "BEGIN:VCALENDAR",
        "VERSION:2.0",
        "PRODID:-//Calo//Calo//EN",
        "X-WR-CALNAME:Calo",
        "BEGIN:VEVENT",
        "UID:assignment-1204417@calo",
        "DTSTAMP:20260924T170000Z",
        "DTSTART:20261003T065959Z",
        "SUMMARY:Assignment 2 [CMPT 225 D100]",
        "URL:https://canvas.sfu.ca/courses/62841/assignments/1204417",
        "END:VEVENT",
        "BEGIN:VEVENT",
        "UID:event-3310245@calo",
        "DTSTAMP:20260924T170000Z",
        "DTSTART:20261015T013000Z",
        "DTEND:20261015T032000Z",
        "SUMMARY:Midterm 1 [PHYS 140 D100]",
        "URL:https://canvas.sfu.ca/calendar?event_id=3310245",
        "END:VEVENT",
        "BEGIN:VEVENT",
        "UID:event-3308871@calo",
        "DTSTAMP:20260924T170000Z",
        "DTSTART;VALUE=DATE:20261012",
        "SUMMARY:No lecture [CMPT 225 D100]",
        "URL:https://canvas.sfu.ca/calendar?event_id=3308871",
        "END:VEVENT",
        "END:VCALENDAR",
        "",
      ].join("\r\n"),
    );
  });

  it("escapes text but leaves the URL alone", () => {
    const ics = generateIcs(
      [
        {
          ...deadline,
          title: "Lab 4: stacks, queues; deques \\ notes\nPart 2",
          url: "https://canvas.sfu.ca/courses/62841/files?ids=1,2",
        },
      ],
      now,
    );
    expect(ics).toContain(
      String.raw`SUMMARY:Lab 4: stacks\, queues\; deques \\ notes\nPart 2 [CMPT 225 D100]` +
        "\r\n",
    );
    expect(ics).toContain("URL:https://canvas.sfu.ca/courses/62841/files?ids=1,2\r\n");
  });

  it("folds at 75 bytes without splitting a character", () => {
    // A run of ASCII fills a continuation line exactly; then 2-, 3-, and
    // 4-byte characters, long enough that folds land among each.
    const title =
      "Résumé – " + "a".repeat(200) + "é".repeat(40) + "–".repeat(30) + "🚀".repeat(20);
    const ics = generateIcs([{ ...deadline, title }], now);
    const lines = ics.split("\r\n");
    expect(lines.length).toBeGreaterThan(12); // the summary really was folded
    for (const line of lines) {
      expect(Buffer.byteLength(line)).toBeLessThanOrEqual(75);
      expect(line.isWellFormed()).toBe(true); // no half of an emoji's surrogate pair
    }
    expect(ics.replaceAll("\r\n ", "")).toContain(
      `SUMMARY:${title} [CMPT 225 D100]\r\n`,
    );
  });

  it("puts an all-day event on the date its creator picked", () => {
    // Midnight Oct 12 in Vancouver, in UTC (Canvas feed items), and in UTC+8.
    for (const start of [
      "2026-10-12T07:00:00Z",
      "2026-10-12T00:00:00Z",
      "2026-10-11T16:00:00Z",
    ]) {
      const ics = generateIcs([{ ...holiday, start, end: start }], now);
      expect(ics).toContain("DTSTART;VALUE=DATE:20261012\r\n");
    }
  });
});
