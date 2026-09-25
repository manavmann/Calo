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
