import { GOOGLE_SCOPE, type PlannerItem } from "@calo/core";
import { vi } from "vitest";

export const GOOGLE_TOKEN_URL = "https://oauth2.googleapis.com/token";
const GOOGLE_REVOKE_URL = "https://oauth2.googleapis.com/revoke";
const CALENDAR_API = "https://www.googleapis.com/calendar/v3";

/** Where Calo reads and writes a Google calendar. */
export function calendarUrl(calendarId: string): string {
  return `${CALENDAR_API}/calendars/${encodeURIComponent(calendarId)}`;
}

export interface LoggedRequest {
  method: string;
  url: string;
  /** Parsed from JSON or a form, or null if there was none. */
  body: any;
  /** The status the fake answered with. */
  status: number;
}

type GoogleEvent = { id: string; status: string; [field: string]: unknown };

/**
 * Stands in for canvas.sfu.ca and Google in the API's tests, by stubbing
 * fetch. Canvas serves whatever items or feed a test sets. Google keeps its
 * calendars and events, so tests check what ends up on the student's
 * calendar, not the exact calls push made.
 *
 * Google's side behaves the way Calo assumes the real one does: a deleted
 * event's id stays taken, so inserting it again is a 409, deleting it again
 * is a 410, and an update with status "confirmed" brings it back. A test
 * passing against this shows Calo's half of that, not Google's.
 */
export function fakeNetwork() {
  const requests: LoggedRequest[] = [];
  const failures: { match: (request: LoggedRequest) => boolean; response: Response }[] = [];
  const calendars = new Map<string, Map<string, { event: GoogleEvent; deleted: boolean }>>();
  let calendarCount = 0;

  const network = {
    canvas: { items: [] as PlannerItem[], feed: "" },
    google: {
      calendars,
      /** Refresh tokens Google no longer accepts, as when the student removes Calo's access. */
      revokedTokens: new Set<string>(),
      /** The scopes the student leaves ticked on the consent screen. */
      grantedScope: GOOGLE_SCOPE,
      /** The Calo ids of the events on a calendar that aren't deleted, sorted. */
      liveEvents(calendarId: string): string[] {
        return [...(calendars.get(calendarId) ?? [])]
          .filter(([, stored]) => !stored.deleted)
          .map(([id]) => caloId(id))
          .sort();
      },
      /** The event Calo last sent for a Calo id, deleted or not. */
      event(calendarId: string, eventId: string): GoogleEvent | undefined {
        return calendars.get(calendarId)?.get(googleId(eventId))?.event;
      },
      /** As when the student deletes an event in Google Calendar. */
      deleteEvent(calendarId: string, eventId: string) {
        calendars.get(calendarId)!.get(googleId(eventId))!.deleted = true;
      },
    },
    /** Every request made, in order. */
    requests,
    googleRequests(): LoggedRequest[] {
      return requests.filter((request) => !request.url.startsWith("https://canvas.sfu.ca/"));
    },
    /** Answers the next request `match` accepts with `response`, instead of as usual. */
    failNext(match: (request: LoggedRequest) => boolean, response: Response) {
      failures.push({ match, response });
    },
  };

  vi.stubGlobal("fetch", async (input: string, init?: RequestInit): Promise<Response> => {
    const req = new Request(input, init);
    const text = await req.text();
    const request: LoggedRequest = {
      method: req.method,
      url: req.url,
      body: !text
        ? null
        : req.headers.get("content-type")?.startsWith("application/json")
          ? JSON.parse(text)
          : Object.fromEntries(new URLSearchParams(text)),
      status: 0,
    };
    requests.push(request);
    const failure = failures.findIndex(({ match }) => match(request));
    const response =
      failure === -1 ? answer(request) : failures.splice(failure, 1)[0]!.response;
    request.status = response.status;
    return response;
  });

  function answer({ method, url, body }: LoggedRequest): Response {
    const { origin, pathname } = new URL(url);
    if (origin === "https://canvas.sfu.ca") {
      if (pathname === "/api/v1/planner/items") return Response.json(network.canvas.items);
      if (pathname.startsWith("/feeds/calendars/")) return new Response(network.canvas.feed);
    }
    if (url === GOOGLE_TOKEN_URL) return token(body);
    if (url === GOOGLE_REVOKE_URL) {
      network.google.revokedTokens.add(body.token);
      return Response.json({});
    }
    if (url.startsWith(`${CALENDAR_API}/calendars`)) {
      return calendarApi(method, pathname.split("/").slice(4), body);
    }
    throw new Error(`Unexpected request: ${method} ${url}`);
  }

  function token(body: Record<string, string>): Response {
    if (body.grant_type === "authorization_code") {
      return Response.json({
        access_token: "access",
        refresh_token: `refresh-${body.code}`,
        scope: network.google.grantedScope,
      });
    }
    if (network.google.revokedTokens.has(body.refresh_token!)) {
      return Response.json({ error: "invalid_grant" }, { status: 400 });
    }
    return Response.json({ access_token: "access" });
  }

  // `path` is what follows /calendar/v3/calendars: [], [id], [id, "events"],
  // or [id, "events", eventId].
  function calendarApi(method: string, path: string[], body: any): Response {
    const [encodedId, , eventId] = path;
    if (method === "POST" && encodedId === undefined) {
      const id = `calendar-${++calendarCount}@group.calendar.google.com`;
      calendars.set(id, new Map());
      return Response.json({ id, summary: body.summary });
    }
    const calendarId = decodeURIComponent(encodedId!);
    const events = calendars.get(calendarId);
    if (!events) return calendarError(404, "notFound");

    if (path.length === 1 && method === "GET") return Response.json({ id: calendarId });
    if (path.length === 1 && method === "DELETE") {
      calendars.delete(calendarId);
      return new Response(null, { status: 204 });
    }
    if (path.length === 2 && method === "POST") {
      if (events.has(body.id)) return calendarError(409, "duplicate");
      events.set(body.id, { event: body, deleted: false });
      return Response.json(body);
    }
    const stored = events.get(eventId!);
    if (!stored) return calendarError(404, "notFound");
    if (method === "PUT") {
      events.set(eventId!, { event: body, deleted: stored.deleted && body.status !== "confirmed" });
      return Response.json(body);
    }
    if (method === "DELETE") {
      if (stored.deleted) return calendarError(410, "deleted");
      stored.deleted = true;
      return new Response(null, { status: 204 });
    }
    throw new Error(`Unexpected request: ${method} /calendars/${path.join("/")}`);
  }

  return network;
}

export function calendarError(status: number, reason: string): Response {
  return Response.json({ error: { code: status, errors: [{ reason }] } }, { status });
}

// Calo makes Google event ids by hex-encoding its own (see google.ts in core).
function googleId(caloId: string): string {
  return Buffer.from(caloId).toString("hex");
}

function caloId(googleId: string): string {
  return Buffer.from(googleId, "hex").toString();
}
