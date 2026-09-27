import type { CaloEvent } from "./event.js";

// The only Canvas we talk to. It's a constant, not a parameter, so a token
// can't be sent to another host by passing the wrong URL.
const CANVAS_ORIGIN = "https://canvas.sfu.ca";

// The student's own feed, from Calendar -> Calendar Feed. A course's feed
// (course_...) only has that one course, so it isn't accepted.
const FEED_PATH = /^\/feeds\/calendars\/user_[A-Za-z0-9]+\.ics$/;

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
 * Canvas answered with an error status. The message leaves out the URL, since
 * a feed's URL is the secret that grants access to it.
 */
export class CanvasError extends Error {
  readonly status: number;

  constructor(status: number, statusText: string) {
    super(`Canvas responded ${status} ${statusText}`);
    this.status = status;
  }
}

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
    const res = await canvasGet(url, token);
    items.push(...((await res.json()) as PlannerItem[]));
    url = nextPageUrl(res.headers.get("link"));
  }
  return items;
}

/** Resolves if Canvas accepts the token. A rejected token is a CanvasError with status 401. */
export async function verifyCanvasToken(token: string): Promise<void> {
  await canvasGet(`${CANVAS_ORIGIN}/api/v1/users/self`, token);
}

/**
 * `input` as a canvas.sfu.ca user feed URL, or null if it isn't one. Whoever
 * has this URL can read the feed, so it's as sensitive as a token.
 */
export function canvasFeedUrl(input: string): string | null {
  // Parsed rather than matched as a string: in https://canvas.sfu.ca@evil.example,
  // "canvas.sfu.ca" is a username and the host is evil.example.
  const url = URL.parse(input);
  if (url?.origin !== CANVAS_ORIGIN || !FEED_PATH.test(url.pathname)) {
    return null;
  }
  // Canvas ignores any query or fragment, so they're dropped.
  return `${CANVAS_ORIGIN}${url.pathname}`;
}

/** Fetches a feed URL as returned by canvasFeedUrl. */
export async function fetchCanvasFeed(feedUrl: string): Promise<string> {
  // Checked here too, so no caller can make the server fetch some other URL.
  if (canvasFeedUrl(feedUrl) !== feedUrl) {
    throw new Error("Refusing to fetch a Canvas feed from anywhere but canvas.sfu.ca");
  }
  const res = await fetch(feedUrl, { redirect: "error" });
  if (!res.ok) throw new CanvasError(res.status, res.statusText);
  return res.text();
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
      // TODO: personal events get the student's name here, which leaks into titles.
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

// The only place a Canvas token is attached to a request.
async function canvasGet(url: string, token: string): Promise<Response> {
  // Paginated requests get their next URL from Canvas's Link header, so every
  // URL is checked, not just the first. The origin includes the scheme, so
  // http://canvas.sfu.ca is refused too.
  const { origin } = new URL(url);
  if (origin !== CANVAS_ORIGIN) {
    throw new Error(`Refusing to send the Canvas token to ${origin}`);
  }
  const res = await fetch(url, {
    headers: { Authorization: `Bearer ${token}` },
    // Canvas doesn't redirect its https API. fetch would follow a redirect,
    // dropping the token if it left canvas.sfu.ca but still returning the
    // other host's response as if it were Canvas's.
    redirect: "error",
  });
  if (!res.ok) throw new CanvasError(res.status, res.statusText);
  return res;
}

// Canvas's Link header looks like: <url>; rel="current",<url>; rel="next",...
function nextPageUrl(link: string | null): string | null {
  return link?.match(/<([^>]+)>;\s*rel="next"/)?.[1] ?? null;
}
