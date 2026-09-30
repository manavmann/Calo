import { createHash } from "node:crypto";
import { Hono } from "hono";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { decrypt } from "./encryption.ts";
import { calendarError, calendarUrl, fakeNetwork, GOOGLE_TOKEN_URL } from "./fake-network.ts";
import { googleConnection } from "./google-connection.ts";
import { pushToGoogle } from "./google-push.ts";
import { createSession, SESSION_COOKIE } from "./session.ts";
import { syncUser } from "./sync.ts";
import {
  assignment,
  connectCanvas,
  connectGoogle,
  googleConnectionRow,
  newUser,
  REFRESH_TOKEN,
} from "./test-fixtures.ts";

// Mounted where server.ts mounts it. server.ts itself isn't imported, since
// it starts listening on a port.
const app = new Hono().route("/api/google", googleConnection);

let network: ReturnType<typeof fakeNetwork>;
let userId: string;
let session: string;

beforeEach(async () => {
  network = fakeNetwork();
  userId = (await newUser()).id;
  session = `${SESSION_COOKIE}=${(await createSession(userId)).token}`;
});

afterEach(() => {
  vi.unstubAllGlobals();
});

// What the student's browser does on "Connect Google Calendar": returns
// Google's consent URL, and the cookie /connect set for the way back.
async function startConnecting() {
  const res = await app.request("/api/google/connect", { headers: { Cookie: session } });
  expect(res.status).toBe(302);
  const consentUrl = new URL(res.headers.get("location")!);
  // "calo_google_oauth=<state>.<verifier>", without the attributes.
  const oauthCookie = res.headers.get("set-cookie")!.split(";")[0]!;
  return { consentUrl, state: consentUrl.searchParams.get("state")!, oauthCookie };
}

// Google sending the student back.
function callback(query: Record<string, string>, oauthCookie?: string) {
  return app.request(`/api/google/callback?${new URLSearchParams(query)}`, {
    headers: { Cookie: oauthCookie ? `${session}; ${oauthCookie}` : session },
  });
}

// The whole round trip, with the student allowing access. The fake gives back
// the refresh token "refresh-<code>".
async function connectThroughGoogle(code: string) {
  const { state, oauthCookie } = await startConnecting();
  return callback({ state, code }, oauthCookie);
}

describe("connecting Google Calendar", () => {
  it("round-trips through Google with PKCE, and stores the refresh token only encrypted", async () => {
    const { consentUrl, state, oauthCookie } = await startConnecting();
    // Google gets the challenge now, and the verifier behind it at /callback.
    const verifier = oauthCookie.split(".")[1]!;
    expect(consentUrl.searchParams.get("code_challenge")).toBe(
      createHash("sha256").update(verifier).digest("base64url"),
    );

    expect((await callback({ state, code: "auth-code" }, oauthCookie)).status).toBe(200);
    expect(network.googleRequests()).toMatchObject([
      {
        url: GOOGLE_TOKEN_URL,
        body: { grant_type: "authorization_code", code: "auth-code", code_verifier: verifier },
      },
    ]);
    const row = (await googleConnectionRow(userId))!;
    expect(row.revokedAt).toBeNull();
    expect(row.refreshToken).not.toContain("refresh-auth-code");
    expect(decrypt(row.refreshToken, userId)).toBe("refresh-auth-code");
  });

  // Otherwise a link with an attacker's own code could connect the student's
  // Calo to the attacker's calendar.
  it("refuses a callback whose state doesn't match this browser's, without asking Google", async () => {
    const { oauthCookie } = await startConnecting();
    const res = await callback({ state: "attacker-state", code: "attacker-code" }, oauthCookie);
    expect(res.status).toBe(400);
    expect(network.googleRequests()).toEqual([]);
    expect(await googleConnectionRow(userId)).toBeUndefined();
  });

  it("refuses a callback without the cookie from /connect, without asking Google", async () => {
    const { state } = await startConnecting();
    const res = await callback({ state, code: "auth-code" });
    expect(res.status).toBe(400);
    expect(network.googleRequests()).toEqual([]);
    expect(await googleConnectionRow(userId)).toBeUndefined();
  });

  it("stores nothing when the student clicks Cancel on Google's consent screen", async () => {
    const { state, oauthCookie } = await startConnecting();
    const res = await callback({ state, error: "access_denied" }, oauthCookie);
    expect(res.status).toBe(400);
    expect(network.googleRequests()).toEqual([]);
    expect(await googleConnectionRow(userId)).toBeUndefined();
  });

  it("stores nothing when the student unticks Calo's permission", async () => {
    network.google.grantedScope = "";
    expect((await connectThroughGoogle("auth-code")).status).toBe(400);
    expect(await googleConnectionRow(userId)).toBeUndefined();
  });

  it("stores nothing when Google refuses the code", async () => {
    network.failNext(
      ({ url }) => url === GOOGLE_TOKEN_URL,
      Response.json({ error: "invalid_grant" }, { status: 400 }),
    );
    expect((await connectThroughGoogle("auth-code")).status).toBe(502);
    expect(await googleConnectionRow(userId)).toBeUndefined();
  });

  it("reconnecting after the token died keeps the calendar and catches it up on the next push", async () => {
    await connectCanvas(userId);
    network.canvas.items = [assignment(1)];
    await syncUser(userId);
    await connectThroughGoogle("first");
    await pushToGoogle(userId);
    const { calendarId } = (await googleConnectionRow(userId))!;

    // The student removes Calo's access, and an assignment is posted meanwhile.
    network.google.revokedTokens.add("refresh-first");
    network.canvas.items = [assignment(1), assignment(2)];
    await syncUser(userId);
    expect(await pushToGoogle(userId)).toEqual({ status: "needs reconnect" });

    await connectThroughGoogle("second");
    const row = (await googleConnectionRow(userId))!;
    expect(row).toMatchObject({ calendarId, revokedAt: null });
    expect(decrypt(row.refreshToken, userId)).toBe("refresh-second");

    expect(await pushToGoogle(userId)).toEqual({
      status: "pushed",
      newCalendar: false,
      written: ["assignment-2"],
      removed: [],
    });
    expect(network.google.liveEvents(calendarId!)).toEqual(["assignment-1", "assignment-2"]);
  });
});

describe("disconnecting Google Calendar", () => {
  function disconnect() {
    return app.request("/api/google", { method: "DELETE", headers: { Cookie: session } });
  }

  // Connected, with the Calo calendar made by a first push. Returns its id.
  async function connectedWithCalendar(): Promise<string> {
    await connectGoogle(userId);
    await pushToGoogle(userId);
    return (await googleConnectionRow(userId))!.calendarId!;
  }

  it("deletes Calo's calendar, revokes the token, and forgets the connection", async () => {
    const calendarId = await connectedWithCalendar();
    expect((await disconnect()).status).toBe(204);
    expect(network.google.calendars.has(calendarId)).toBe(false);
    expect(network.google.revokedTokens.has(REFRESH_TOKEN)).toBe(true);
    expect(await googleConnectionRow(userId)).toBeUndefined();
  });

  it("finishes when the student already deleted the calendar", async () => {
    const calendarId = await connectedWithCalendar();
    network.google.calendars.delete(calendarId);
    expect((await disconnect()).status).toBe(204);
    expect(network.google.revokedTokens.has(REFRESH_TOKEN)).toBe(true);
    expect(await googleConnectionRow(userId)).toBeUndefined();
  });

  it("forgets a connection that needs reconnecting without calling Google", async () => {
    await connectGoogle(userId, new Date());
    expect((await disconnect()).status).toBe(204);
    expect(network.googleRequests()).toEqual([]);
    expect(await googleConnectionRow(userId)).toBeUndefined();
  });

  // Dead, but no push has noticed yet. There's no way into the account, so
  // the calendar has to stay.
  it("forgets a connection whose token just died", async () => {
    const calendarId = await connectedWithCalendar();
    network.google.revokedTokens.add(REFRESH_TOKEN);
    expect((await disconnect()).status).toBe(204);
    expect(network.google.calendars.has(calendarId)).toBe(true);
    expect(await googleConnectionRow(userId)).toBeUndefined();
  });

  it("keeps the connection when Google errors, so trying again finishes the job", async () => {
    const calendarId = await connectedWithCalendar();
    network.failNext(
      ({ method, url }) => method === "DELETE" && url === calendarUrl(calendarId),
      calendarError(503, "backendError"),
    );

    expect((await disconnect()).status).toBe(502);
    expect(await googleConnectionRow(userId)).toBeDefined();
    expect(network.google.revokedTokens.has(REFRESH_TOKEN)).toBe(false);

    expect((await disconnect()).status).toBe(204);
    expect(network.google.calendars.has(calendarId)).toBe(false);
    expect(await googleConnectionRow(userId)).toBeUndefined();
  });
});
