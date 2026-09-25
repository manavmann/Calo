// Logs in as any email without OAuth, for local development:
//   pnpm --filter @calo/api dev:session you@sfu.ca
import { db } from "../src/db.ts";
import { users } from "../src/schema.ts";
import { createSession, SESSION_COOKIE } from "../src/session.ts";

// Whoever runs this can become any user, so it refuses any database that isn't
// on this machine, such as one reached with a production DATABASE_URL. It
// checks the hosts the driver will actually connect to, not a re-parse of the URL.
const LOCAL_HOSTS = new Set(["localhost", "127.0.0.1"]);
const hosts = db.$client.options.host;
if (!hosts.every((host) => LOCAL_HOSTS.has(host))) {
  console.error(`Refusing to run: DATABASE_URL points at ${hosts.join(", ")}, not a local database.`);
  process.exit(1);
}

const email = process.argv[2]?.trim().toLowerCase();
if (!email) {
  console.error("Usage: pnpm --filter @calo/api dev:session you@sfu.ca");
  process.exit(1);
}

// "do update" rather than "do nothing", because only an updated row comes back
// from returning(); with "do nothing" an existing user would return no row.
const [user] = await db
  .insert(users)
  .values({ email })
  .onConflictDoUpdate({ target: users.email, set: { email } })
  .returning();
const { token, expiresAt } = await createSession(user!.id);
await db.$client.end();

console.log(`Session for ${email}, expires ${expiresAt.toISOString()}

  ${SESSION_COOKIE}=${token}

In Chrome devtools on http://localhost:3000, open Application > Cookies and add
a cookie named ${SESSION_COOKIE} with the value above. Or with curl:

  curl -H "Cookie: ${SESSION_COOKIE}=${token}" http://localhost:3000/api/me`);
