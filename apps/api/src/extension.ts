import { randomBytes } from "node:crypto";
import { CANVAS_ORIGIN, type PlannerItem } from "@calo/core";
import { and, eq, gt, sql } from "drizzle-orm";
import { Hono } from "hono";
import { createMiddleware } from "hono/factory";
import { db } from "./db.ts";
import { canvasConnections, pairingCodes, users } from "./schema.ts";
import { hashToken, requireSession } from "./session.ts";
import { ingestPlannerItems, PLANNER_FUTURE_DAYS, PLANNER_PAST_DAYS } from "./sync.ts";

// Mounted at /api/extension. Where the browser extension pairs with a
// student's account, then posts the planner items it reads from Canvas with
// the student's logged-in session. Canvas's cookies never leave the browser:
// all that arrives here is the items, and Calo's own device token.
export const extension = new Hono();

const DAY_MS = 24 * 60 * 60 * 1000;

// Long enough to switch to the extension and paste the code in.
const PAIRING_CODE_TTL_MS = 10 * 60 * 1000;

// How far the extension's clock may be from the server's (see
// isPlannerWindow). A computer set to the wrong timezone is off by up to a
// day; one off by more has a window that can't be trusted.
const CLOCK_SKEW_MS = 2 * DAY_MS;

// Makes a code for the student to paste into the extension, replacing any
// they haven't used. The code only hands over the device token: what the
// student copies stops working once used or after 10 minutes, and the token
// that lasts goes straight from /pair into the extension, never on screen.
extension.post("/pairing-code", requireSession, async (c) => {
  // 256 random bits, like a session token, so /pair needs no rate limit.
  const code = randomBytes(32).toString("base64url");
  const values = {
    codeHash: hashToken(code),
    expiresAt: new Date(Date.now() + PAIRING_CODE_TTL_MS),
  };
  await db
    .insert(pairingCodes)
    .values({ userId: c.get("user").id, ...values })
    .onConflictDoUpdate({ target: pairingCodes.userId, set: values });
  return c.json({ code, expiresAt: values.expiresAt });
});

// Trades a pairing code for a device token. No session: the code is the
// credential. Pairing makes the extension the student's Canvas connection,
// replacing a token, a feed, or an extension paired before, whose device
// token stops working.
extension.post("/pair", async (c) => {
  const body = await c.req.json().catch(() => null);
  // Trimmed, since it's pasted.
  const code = typeof body?.code === "string" ? body.code.trim() : "";
  // 256 random bits, stored only hashed, like a session token.
  const token = randomBytes(32).toString("base64url");
  const deviceTokenHash = hashToken(token);

  const email = await db.transaction(async (tx) => {
    // Deleting the code is what makes it single use: of two requests with the
    // same code at once, only one gets the row back.
    const [redeemed] = await tx
      .delete(pairingCodes)
      .where(
        and(eq(pairingCodes.codeHash, hashToken(code)), gt(pairingCodes.expiresAt, new Date())),
      )
      .returning({ userId: pairingCodes.userId });
    if (!redeemed) {
      return null;
    }
    const { userId } = redeemed;
    await tx
      .insert(canvasConnections)
      .values({ userId, method: "extension", deviceTokenHash })
      .onConflictDoUpdate({
        target: canvasConnections.userId,
        set: { method: "extension", secret: null, deviceTokenHash, connectedAt: sql`now()` },
      });
    const [user] = await tx.select({ email: users.email }).from(users).where(eq(users.id, userId));
    return user!.email;
  });

  // Unknown, used, and expired codes all get the same answer.
  if (email === null) {
    return c.json({ error: "This code doesn't work. Make a new one and paste it in." }, 400);
  }
  // The email is so the extension can show whose account it's paired with: a
  // student talked into pasting someone else's code can see it.
  return c.json({ token, email });
});

// The extension's only credential, as a bearer token. One that's unknown or
// was replaced gets the same 401 as none at all.
const requireDevice = createMiddleware<{ Variables: { userId: string } }>(async (c, next) => {
  const token = c.req.header("Authorization")?.match(/^Bearer (\S+)$/)?.[1];
  const [row] = token
    ? await db
        .select({ userId: canvasConnections.userId })
        .from(canvasConnections)
        .where(eq(canvasConnections.deviceTokenHash, hashToken(token)))
    : [];
  if (!row) {
    return c.json({ error: "unauthorized" }, 401);
  }
  c.set("userId", row.userId);
  await next();
});

// The body is { start, end, items }: the window the extension asked Canvas's
// planner for, and the items it got back, trimmed to PlannerItem's fields.
// It's checked in full before anything is written.
extension.post("/ingest", requireDevice, async (c) => {
  const body = await c.req.json().catch(() => null);
  if (
    !isRecord(body) ||
    !isDate(body.start) ||
    !isDate(body.end) ||
    !Array.isArray(body.items) ||
    !body.items.every(isPlannerItem)
  ) {
    return c.json({ error: "Malformed planner items." }, 400);
  }
  const window = { start: new Date(body.start), end: new Date(body.end) };
  if (!isPlannerWindow(window, Date.now())) {
    return c.json(
      { error: "This computer's clock is wrong. Set the right date and time, then sync again." },
      400,
    );
  }

  // An empty list is taken at its word, like an empty pull with a token. The
  // extension sends nothing when Canvas fails, so empty means the planner is.
  const { added, changed, deleted } = await ingestPlannerItems(
    c.get("userId"),
    body.items,
    window,
  );
  // Only counts: a device token can put a student's items in, but can't read
  // anything back out.
  return c.json({ added: added.length, changed: changed.length, deleted: deleted.length });
});

// Whether the extension could have sent this window. It asks for the planner
// window around its own clock (see PLANNER_PAST_DAYS in sync.ts), so the
// window can't be longer than that, and has to start within CLOCK_SKEW_MS of
// where the server's clock would start it. Sync deletes whatever is missing
// from inside the window, so without this a bad client could clear any span of
// a student's calendar, not just the one a real sync covers.
function isPlannerWindow({ start, end }: { start: Date; end: Date }, now: number): boolean {
  const span = end.getTime() - start.getTime();
  const expectedStart = now - PLANNER_PAST_DAYS * DAY_MS;
  return (
    span > 0 &&
    span <= (PLANNER_PAST_DAYS + PLANNER_FUTURE_DAYS) * DAY_MS &&
    Math.abs(start.getTime() - expectedStart) <= CLOCK_SKEW_MS
  );
}

// The fields normalizePlannerItems reads, with the types it expects. The link
// has to resolve to canvas.sfu.ca, as every real one does, so a leaked device
// token can't put links to anywhere else on a student's calendar.
function isPlannerItem(value: unknown): value is PlannerItem {
  if (!isRecord(value)) {
    return false;
  }
  const plannable = value.plannable;
  if (!isRecord(plannable)) {
    return false;
  }
  return (
    typeof value.plannable_type === "string" &&
    Number.isSafeInteger(value.plannable_id) &&
    isDate(value.plannable_date) &&
    typeof value.html_url === "string" &&
    URL.parse(value.html_url, CANVAS_ORIGIN)?.origin === CANVAS_ORIGIN &&
    typeof value.context_name === "string" &&
    typeof plannable.title === "string" &&
    (plannable.end_at === undefined || isDate(plannable.end_at)) &&
    (plannable.all_day === undefined || typeof plannable.all_day === "boolean")
  );
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null;
}

// A string Date can read. Anything else would reach the database as an
// invalid date and fail the insert.
function isDate(value: unknown): value is string {
  return typeof value === "string" && !Number.isNaN(Date.parse(value));
}
