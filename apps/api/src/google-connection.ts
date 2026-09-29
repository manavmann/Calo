import { createHash, randomBytes } from "node:crypto";
import {
  deleteGoogleCalendar,
  exchangeGoogleCode,
  GOOGLE_SCOPE,
  googleAuthUrl,
  GoogleError,
  refreshGoogleAccessToken,
  revokeGoogleToken,
} from "@calo/core";
import { eq, sql } from "drizzle-orm";
import { Hono } from "hono";
import { deleteCookie, getCookie, setCookie } from "hono/cookie";
import { db } from "./db.ts";
import { decrypt, encrypt } from "./encryption.ts";
import { googleClient } from "./google-client.ts";
import { googleConnections, type User } from "./schema.ts";
import { requireSession } from "./session.ts";

// Mounted at /api/google. Connecting is a round trip through Google: /connect
// sends the student to Google's consent screen, and Google sends them back to
// /callback with a code that Calo trades for a refresh token.
export const googleConnection = new Hono<{ Variables: { user: User } }>();

googleConnection.use(requireSession);

// Holds the state and PKCE verifier from /connect until /callback. Lax, like
// the session cookie, since coming back from Google is a navigation from
// another site: a Strict cookie wouldn't be sent with it.
const OAUTH_COOKIE = "calo_google_oauth";
const OAUTH_COOKIE_OPTIONS = {
  path: "/api/google/callback",
  httpOnly: true,
  secure: true,
  sameSite: "Lax",
  maxAge: 10 * 60,
} as const;

googleConnection.get("/", async (c) => {
  const [row] = await db
    .select({ revokedAt: googleConnections.revokedAt, connectedAt: googleConnections.connectedAt })
    .from(googleConnections)
    .where(eq(googleConnections.userId, c.get("user").id));
  return c.json(
    row
      ? { connected: true, needsReconnect: row.revokedAt !== null, connectedAt: row.connectedAt }
      : { connected: false },
  );
});

googleConnection.get("/connect", (c) => {
  const state = randomBytes(32).toString("base64url");
  const verifier = randomBytes(32).toString("base64url");
  // "." can't appear in base64url, so it can't be confused for part of either.
  setCookie(c, OAUTH_COOKIE, `${state}.${verifier}`, OAUTH_COOKIE_OPTIONS);
  const challenge = createHash("sha256").update(verifier).digest("base64url");
  return c.redirect(googleAuthUrl(googleClient, state, challenge));
});

googleConnection.get("/callback", async (c) => {
  const [state, verifier] = getCookie(c, OAUTH_COOKIE)?.split(".") ?? [];
  deleteCookie(c, OAUTH_COOKIE, OAUTH_COOKIE_OPTIONS);
  // This GET changes data, the one exception to the rule in session.ts, so
  // it checks that the state matches what /connect put in this browser's
  // cookie. Otherwise a link here with the attacker's own code would connect
  // the victim's Calo to the attacker's calendar. The PKCE verifier covers the
  // reverse: a code stolen from the victim is useless without the verifier
  // from the victim's cookie.
  if (!state || !verifier || c.req.query("state") !== state) {
    return c.text("This link has expired. Start connecting Google Calendar again.", 400);
  }
  // No code when the student clicked Cancel (Google sends error=access_denied).
  const code = c.req.query("code");
  if (!code) {
    return c.text("Google Calendar wasn't connected.", 400);
  }

  let granted;
  try {
    granted = await exchangeGoogleCode(googleClient, code, verifier);
  } catch (err) {
    if (!(err instanceof GoogleError)) throw err;
    return c.text("Google returned an error. Try connecting again.", 502);
  }
  // Google lets people untick permissions on the consent screen. Without this
  // one, every push would fail.
  if (!granted.scopes.includes(GOOGLE_SCOPE)) {
    return c.text(
      "Calo needs permission to manage its own calendar. Connect again and leave it ticked.",
      400,
    );
  }

  const userId = c.get("user").id;
  const refreshToken = encrypt(granted.refreshToken, userId);
  await db
    .insert(googleConnections)
    .values({ userId, refreshToken })
    .onConflictDoUpdate({
      target: googleConnections.userId,
      // calendar_id is kept. If it's in a different Google account from this
      // one, the next push finds it missing and makes a new calendar.
      set: { refreshToken, revokedAt: null, connectedAt: sql`now()` },
    });
  // Until there's a dashboard to send the student back to.
  return c.text("Google Calendar connected. Its Calo calendar fills in on the next sync.");
});

// Removes the Calo calendar from the student's Google account and revokes the
// refresh token, so nothing Calo made is left going stale, and a copy of the
// token in an old database backup stops working.
googleConnection.delete("/", async (c) => {
  const userId = c.get("user").id;
  const [row] = await db
    .select()
    .from(googleConnections)
    .where(eq(googleConnections.userId, userId));
  // With a dead token there's no way into the account. The calendar stays,
  // but the student removed Calo's access themselves, so they know it's there.
  if (row && row.revokedAt === null) {
    try {
      const refreshToken = decrypt(row.refreshToken, userId);
      const accessToken = await refreshGoogleAccessToken(googleClient, refreshToken);
      if (accessToken !== null) {
        if (row.calendarId !== null) {
          await deleteGoogleCalendar(accessToken, row.calendarId);
        }
        await revokeGoogleToken(refreshToken);
      }
    } catch (err) {
      if (!(err instanceof GoogleError)) throw err;
      // The row stays, so trying again finishes the job. A calendar that's
      // already gone counts as deleted.
      return c.json({ error: "Google returned an error. Try again later." }, 502);
    }
  }
  // synced_events.google_hash is left as is: the next connect has no
  // calendar_id, and the push that makes the new calendar resets it.
  await db.delete(googleConnections).where(eq(googleConnections.userId, userId));
  return c.body(null, 204);
});
