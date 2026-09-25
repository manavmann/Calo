import { createHash, randomBytes } from "node:crypto";
import { and, eq, gt } from "drizzle-orm";
import { getCookie } from "hono/cookie";
import { createMiddleware } from "hono/factory";
import { db } from "./db.ts";
import { sessions, users, type User } from "./schema.ts";

const SESSION_TTL_MS = 30 * 24 * 60 * 60 * 1000;

export const SESSION_COOKIE = "calo_session";

// Secure everywhere, not just in production: Chrome and Firefox accept Secure
// cookies on http://localhost, so there's no dev/prod switch to get wrong.
// Lax keeps the cookie off cross-site POSTs and fetches, which stops CSRF as
// long as no GET route changes state.
export const SESSION_COOKIE_OPTIONS = {
  path: "/",
  httpOnly: true,
  secure: true,
  sameSite: "Lax",
} as const;

// Only the hash is stored, so reading the sessions table (a leaked backup,
// db:studio on a screen-share) doesn't hand out working sessions. A fast hash
// is enough: the token is 256 random bits, so there's nothing to brute-force.
function hashToken(token: string): string {
  return createHash("sha256").update(token).digest("hex");
}

export async function createSession(
  userId: string,
): Promise<{ token: string; expiresAt: Date }> {
  const token = randomBytes(32).toString("base64url");
  const expiresAt = new Date(Date.now() + SESSION_TTL_MS);
  await db.insert(sessions).values({ id: hashToken(token), userId, expiresAt });
  return { token, expiresAt };
}

/** The session's user, or null if the token is unknown or expired. */
export async function validateSession(token: string): Promise<User | null> {
  const [row] = await db
    .select({ user: users })
    .from(sessions)
    .innerJoin(users, eq(sessions.userId, users.id))
    .where(and(eq(sessions.id, hashToken(token)), gt(sessions.expiresAt, new Date())));
  return row?.user ?? null;
}

export async function invalidateSession(token: string): Promise<void> {
  await db.delete(sessions).where(eq(sessions.id, hashToken(token)));
}

/** Rejects with 401 unless the session cookie is valid; puts its user on `c.get("user")`. */
export const requireSession = createMiddleware<{ Variables: { user: User } }>(
  async (c, next) => {
    const token = getCookie(c, SESSION_COOKIE);
    const user = token ? await validateSession(token) : null;
    if (!user) {
      return c.json({ error: "unauthorized" }, 401);
    }
    c.set("user", user);
    await next();
  },
);
