// Syncs one user's Canvas connection. Until syncs run on a schedule, this is
// the way to run one:
//   pnpm --filter @calo/api sync you@sfu.ca
import { eq } from "drizzle-orm";
import { db } from "../src/db.ts";
import { users } from "../src/schema.ts";
import { syncUser } from "../src/sync.ts";

const email = process.argv[2]?.trim().toLowerCase();
if (!email) {
  console.error("Usage: pnpm --filter @calo/api sync you@sfu.ca");
  process.exit(1);
}

const [user] = await db.select({ id: users.id }).from(users).where(eq(users.email, email));
if (!user) {
  console.error(`No user with the email ${email}.`);
  process.exit(1);
}

const { added, changed, deleted } = await syncUser(user.id);
await db.$client.end();

for (const [label, ids] of Object.entries({ added, changed, deleted })) {
  console.log(`${label} (${ids.length})${ids.length > 0 ? ": " + ids.join(", ") : ""}`);
}
