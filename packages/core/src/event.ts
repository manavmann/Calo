// A Canvas item in the one shape the rest of Calo works with.
export interface CaloEvent {
  /** Kind plus Canvas ID, e.g. "quiz-4821". Canvas IDs are only unique within a type. */
  id: string;
  kind: "assignment" | "quiz" | "discussion" | "event";
  title: string;
  /**
   * The course's name, or the student's own nickname for it if they set one.
   * Canvas's calendar feed only gives the course code, and "" for personal events.
   */
  course: string;
  /** Absolute link to the item on Canvas. */
  url: string;
  /** ISO 8601 UTC: the due time for deadlines, the start time for events. */
  start: string;
  /** ISO 8601 UTC end of an event. null for deadlines: a moment, not a range. */
  end: string | null;
  /**
   * All-day items keep Canvas's timestamp (midnight in the creator's
   * timezone) in `start`; turning that into a calendar date is up to the output.
   * Canvas's calendar feed only gives a date, so items from it hold midnight
   * UTC, and it marks assignments due at 11:59 PM all-day too.
   */
  allDay: boolean;
}

const DAY_MS = 24 * 60 * 60 * 1000;

// The two helpers below are shared by the outputs (ics.ts, google.ts), so an
// event can't get one title or date in the feed and another in Google.

/** "Assignment 2 [CMPT 225 D100]", or just the title if there's no course. */
export function displayTitle(event: CaloEvent): string {
  return event.course ? `${event.title} [${event.course}]` : event.title;
}

/**
 * The date ("2026-10-12") of an all-day event, from its `start`.
 *
 * Canvas stores an all-day date as midnight in the creator's timezone.
 * For UTC-11:59 through UTC+12 that's within 12h of the date's UTC midnight
 * (Math.round sends the +12 half-day tie upward, to the right date).
 * Known and accepted misses: UTC-12 (uninhabited) and UTC+13/+14 (NZ
 * summer time, Tonga, Samoa, eastern Kiribati). That only affects events
 * whose creator's Canvas timezone is set there.
 */
export function allDayDate(start: string): string {
  const midnight = Math.round(Date.parse(start) / DAY_MS) * DAY_MS;
  return new Date(midnight).toISOString().slice(0, 10);
}
