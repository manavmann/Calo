import { describe, expect, it } from "vitest";
import type { CaloEvent } from "./event.js";
import { toGoogleEvent } from "./google.js";

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
