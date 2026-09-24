import type { CaloEvent } from "./event.js";

// The only Canvas we talk to. It's a constant, not a parameter, so a token
// can't be sent to another host by passing the wrong URL.
const CANVAS_ORIGIN = "https://canvas.sfu.ca";

/**
 * An item from GET /api/v1/planner/items, reduced to the fields we read.
 * Both ingest paths (the token client below, the browser extension) produce these.
 */
export interface PlannerItem {
  plannable_type: string;
  plannable_id: number;
  /**
   * For graded items, the student's own due date after overrides, which
   * `plannable.due_at` may not reflect. For calendar events, the start time.
   */
  plannable_date: string;
  /** A path for most items; a full URL for calendar events. */
  html_url: string;
  context_name: string;
  plannable: {
    title: string;
    end_at?: string; // calendar events only
    all_day?: boolean; // calendar events only
  };
}

// A Map rather than an object literal, so a type like "constructor" can't
// match something inherited from Object.prototype.
const KINDS = new Map<string, CaloEvent["kind"]>([
  ["assignment", "assignment"],
  ["quiz", "quiz"],
  ["discussion_topic", "discussion"],
  ["calendar_event", "event"],
]);

/**
 * Fetches every planner item between `start` and `end` with a personal access
 * token. Self-testing only: Instructure's API policy forbids asking other
 * users for their tokens.
 */
export async function fetchPlannerItems(
  token: string,
  start: Date,
  end: Date,
): Promise<PlannerItem[]> {
  const params = new URLSearchParams({
    start_date: start.toISOString(),
    end_date: end.toISOString(),
    per_page: "100",
  });
  const items: PlannerItem[] = [];
  let url: string | null = `${CANVAS_ORIGIN}/api/v1/planner/items?${params}`;
  while (url) {
    // After the first page, the URL comes from Canvas's Link header, so check
    // it before attaching the token.
    const { origin } = new URL(url);
    if (origin !== CANVAS_ORIGIN) {
      throw new Error(`Refusing to send the Canvas token to ${origin}`);
    }
    const res = await fetch(url, {
      headers: { Authorization: `Bearer ${token}` },
    });
    if (!res.ok) {
      throw new Error(
        `Canvas planner request failed: ${res.status} ${res.statusText}`,
      );
    }
    items.push(...((await res.json()) as PlannerItem[]));
    url = nextPageUrl(res.headers.get("link"));
  }
  return items;
}

/** Drops planner types Calo doesn't sync (announcements, pages, notes, ...). */
export function normalizePlannerItems(items: PlannerItem[]): CaloEvent[] {
  const events: CaloEvent[] = [];
  for (const item of items) {
    const kind = KINDS.get(item.plannable_type);
    if (!kind) continue;
    const isEvent = kind === "event";
    events.push({
      id: `${kind}-${item.plannable_id}`,
      kind,
      title: item.plannable.title,
      course: item.context_name,
      url: new URL(item.html_url, CANVAS_ORIGIN).href,
      start: item.plannable_date,
      // Canvas saves a missing end as the start, so this fallback only
      // satisfies the type.
      end: isEvent ? (item.plannable.end_at ?? item.plannable_date) : null,
      allDay: isEvent && item.plannable.all_day === true,
    });
  }
  return events;
}

// Canvas's Link header looks like: <url>; rel="current",<url>; rel="next",...
function nextPageUrl(link: string | null): string | null {
  return link?.match(/<([^>]+)>;\s*rel="next"/)?.[1] ?? null;
}
