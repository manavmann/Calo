import { readFileSync } from "node:fs";
import { describe, expect, it } from "vitest";
import { normalizePlannerItems, type PlannerItem } from "./canvas.js";

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
