import { allDayDate, displayTitle, type CaloEvent } from "./event.js";

// Constants, like CANVAS_ORIGIN in canvas.ts, so Google tokens can only ever
// be sent to Google.
const AUTH_URL = "https://accounts.google.com/o/oauth2/v2/auth";
const TOKEN_URL = "https://oauth2.googleapis.com/token";
const REVOKE_URL = "https://oauth2.googleapis.com/revoke";
const CALENDAR_API = "https://www.googleapis.com/calendar/v3";

/**
 * Lets Calo make calendars of its own and manage the events on them. It can't
 * see or change any of the student's other calendars.
 */
export const GOOGLE_SCOPE = "https://www.googleapis.com/auth/calendar.app.created";

const DAY_MS = 24 * 60 * 60 * 1000;

/** Calo's OAuth client, as registered in Google Cloud. */
export interface GoogleClient {
  id: string;
  secret: string;
  /** Has to match a redirect URI registered for the client exactly. */
  redirectUri: string;
}

/**
 * Google answered with an error status. `reason` is Google's code for the
 * error, like "invalid_grant" or "rateLimitExceeded", or "" if it gave none.
 */
export class GoogleError extends Error {
  readonly status: number;
  readonly reason: string;

  constructor(status: number, reason: string) {
    super(`Google responded ${status}${reason ? ` ${reason}` : ""}`);
    this.status = status;
    this.reason = reason;
  }
}

/** Google's consent screen, which sends the student back to the redirect URI. */
export function googleAuthUrl(client: GoogleClient, state: string, codeChallenge: string): string {
  const params = new URLSearchParams({
    client_id: client.id,
    redirect_uri: client.redirectUri,
    response_type: "code",
    scope: GOOGLE_SCOPE,
    // For a refresh token, so sync can reach the calendar when the student
    // isn't around.
    access_type: "offline",
    // Google only returns a refresh token the first time someone consents.
    // Without this, reconnecting could come back without one.
    prompt: "consent",
    state,
    code_challenge: codeChallenge,
    code_challenge_method: "S256",
  });
  return `${AUTH_URL}?${params}`;
}

/** Trades the code Google sent to the redirect URI for a refresh token. */
export async function exchangeGoogleCode(
  client: GoogleClient,
  code: string,
  codeVerifier: string,
): Promise<{ refreshToken: string; scopes: string[] }> {
  const body = (await googleFetch(TOKEN_URL, {
    method: "POST",
    body: new URLSearchParams({
      client_id: client.id,
      client_secret: client.secret,
      redirect_uri: client.redirectUri,
      grant_type: "authorization_code",
      code,
      code_verifier: codeVerifier,
    }),
  })) as { refresh_token?: string; scope: string };
  // prompt=consent should always get one.
  if (!body.refresh_token) {
    throw new Error("Google returned no refresh token");
  }
  return { refreshToken: body.refresh_token, scopes: body.scope.split(" ") };
}

/**
 * A new access token, or null if Google no longer accepts the refresh token:
 * the student removed Calo's access, it went unused for six months, or it's
 * over 7 days old while the Google Cloud app is in Testing.
 */
export async function refreshGoogleAccessToken(
  client: GoogleClient,
  refreshToken: string,
): Promise<string | null> {
  try {
    const body = (await googleFetch(TOKEN_URL, {
      method: "POST",
      body: new URLSearchParams({
        client_id: client.id,
        client_secret: client.secret,
        grant_type: "refresh_token",
        refresh_token: refreshToken,
      }),
    })) as { access_token: string };
    return body.access_token;
  } catch (err) {
    // Only invalid_grant means the token is dead. Anything else, like
    // invalid_client, is a problem with Calo's own setup, not the student's.
    if (err instanceof GoogleError && err.reason === "invalid_grant") return null;
    throw err;
  }
}

/** Revokes a refresh token, along with every access token made from it. */
export async function revokeGoogleToken(refreshToken: string): Promise<void> {
  await googleFetch(REVOKE_URL, {
    method: "POST",
    body: new URLSearchParams({ token: refreshToken }),
  });
}

/** Makes a new, empty calendar named "Calo" in the student's account. Returns its id. */
export async function createGoogleCalendar(accessToken: string): Promise<string> {
  const calendar = (await calendarApi(accessToken, "POST", "/calendars", {
    summary: "Calo",
  })) as { id: string };
  return calendar.id;
}

/** False if the calendar is gone: the student deleted it, or it's in another Google account. */
export async function googleCalendarExists(
  accessToken: string,
  calendarId: string,
): Promise<boolean> {
  try {
    await calendarApi(accessToken, "GET", `/calendars/${encodeURIComponent(calendarId)}`);
    return true;
  } catch (err) {
    if (isGone(err)) return false;
    throw err;
  }
}

/** Deletes the calendar, if it's still there. */
export async function deleteGoogleCalendar(accessToken: string, calendarId: string): Promise<void> {
  try {
    await calendarApi(accessToken, "DELETE", `/calendars/${encodeURIComponent(calendarId)}`);
  } catch (err) {
    if (!isGone(err)) throw err;
  }
}

/**
 * Creates the event, or updates it if its id is taken. Google keeps a deleted
 * event's id reserved, so an event Calo deleted that comes back on Canvas is
 * also an update, which brings it back.
 */
export async function upsertGoogleEvent(
  accessToken: string,
  calendarId: string,
  event: CaloEvent,
): Promise<void> {
  const body = toGoogleEvent(event);
  const events = `/calendars/${encodeURIComponent(calendarId)}/events`;
  try {
    await calendarApi(accessToken, "POST", events, body);
  } catch (err) {
    if (!(err instanceof GoogleError && err.status === 409)) throw err;
    await calendarApi(accessToken, "PUT", `${events}/${body.id}`, body);
  }
}

/** Deletes the event made from the CaloEvent with this id, if it's still there. */
export async function deleteGoogleEvent(
  accessToken: string,
  calendarId: string,
  eventId: string,
): Promise<void> {
  const path = `/calendars/${encodeURIComponent(calendarId)}/events/${googleEventId(eventId)}`;
  try {
    await calendarApi(accessToken, "DELETE", path);
  } catch (err) {
    if (!isGone(err)) throw err;
  }
}

/** The Google Calendar event for `event`. Exported for tests. */
export function toGoogleEvent(event: CaloEvent) {
  return {
    id: googleEventId(event.id),
    summary: displayTitle(event),
    // Google Calendar turns a URL in the description into a link.
    description: event.url,
    ...eventTimes(event),
    // What brings an event back when this is sent as an update to one that
    // was deleted.
    status: "confirmed",
  };
}

// Google needs an end, which ICS doesn't. An all-day event ends the next day,
// since the end date is exclusive. Anything else without an end after its
// start ends when it starts: an instant, as a deadline is in the ICS feed.
function eventTimes(event: CaloEvent) {
  if (event.allDay) {
    const date = allDayDate(event.start);
    const next = new Date(Date.parse(date) + DAY_MS).toISOString().slice(0, 10);
    return { start: { date }, end: { date: next } };
  }
  const end =
    event.end !== null && Date.parse(event.end) > Date.parse(event.start) ? event.end : event.start;
  return { start: { dateTime: event.start }, end: { dateTime: end } };
}

// Made from the Calo id, so Google's ids never have to be stored. Google takes
// 5-1024 characters of a-v and 0-9; hex digits are among them, and the shortest
// Calo id, "quiz-1", is 12 of them. It also means a retry can't duplicate an
// event whose insert went through: the id is taken, so the retry gets a 409.
function googleEventId(caloId: string): string {
  return Buffer.from(caloId).toString("hex");
}

// 404 for something that never existed or this account can't see, 410 for
// something deleted. Either way it isn't there.
function isGone(err: unknown): boolean {
  return err instanceof GoogleError && (err.status === 404 || err.status === 410);
}

async function calendarApi(
  accessToken: string,
  method: string,
  path: string,
  body?: object,
): Promise<unknown> {
  return googleFetch(`${CALENDAR_API}${path}`, {
    method,
    headers: { Authorization: `Bearer ${accessToken}`, "Content-Type": "application/json" },
    body: body && JSON.stringify(body),
  });
}

async function googleFetch(url: string, init: RequestInit): Promise<unknown> {
  // Google's APIs don't redirect. As in canvas.ts, a redirect would otherwise
  // be followed and some other host's response returned as Google's.
  const res = await fetch(url, { ...init, redirect: "error" });
  // Read even when it isn't needed, so the connection is free for the next request.
  const text = await res.text();
  if (!res.ok) throw new GoogleError(res.status, errorReason(text));
  return text ? JSON.parse(text) : null;
}

// The token endpoint answers {"error": "invalid_grant", ...}, the Calendar API
// {"error": {"errors": [{"reason": "notFound", ...}], ...}}. A 502 or 503 from
// Google's front end can be an HTML page instead.
function errorReason(text: string): string {
  try {
    const { error } = JSON.parse(text);
    return typeof error === "string" ? error : (error?.errors?.[0]?.reason ?? "");
  } catch {
    return "";
  }
}
