// Syncs one user's Canvas connection, then pushes the result to their Google
// Calendar if they've connected it. Until syncs run on a schedule, this is
// the way to run one:
//   pnpm --filter @calo/api sync you@sfu.ca
// For a user on the browser extension, it only pushes: the extension sends
// their Canvas items itself.
import { eq } from "drizzle-orm";
import { db } from "../src/db.ts";
import { pushToGoogle } from "../src/google-push.ts";
import { canvasConnections, users } from "../src/schema.ts";
import { syncUser } from "../src/sync.ts";

const email = process.argv[2]?.trim().toLowerCase();
if (!email) {
  console.error("Usage: pnpm --filter @calo/api sync you@sfu.ca");
  process.exit(1);
}

const [user] = await db
  .select({ id: users.id, method: canvasConnections.method })
  .from(users)
  .leftJoin(canvasConnections, eq(canvasConnections.userId, users.id))
  .where(eq(users.email, email));
if (!user) {
  console.error(`No user with the email ${email}.`);
  process.exit(1);
}

if (user.method === "extension") {
  console.log("Canvas: comes from the browser extension, so there's nothing to pull");
} else {
  const { added, changed, deleted } = await syncUser(user.id);
  // Printed before the push, so they show even if it fails.
  printIds({ added, changed, deleted });
}

const push = await pushToGoogle(user.id);
await db.$client.end();

if (push.status === "pushed") {
  console.log(`\nGoogle Calendar${push.newCalendar ? " (made a new Calo calendar)" : ""}`);
  printIds({ written: push.written, removed: push.removed });
} else if (push.status === "needs reconnect") {
  console.log("\nGoogle Calendar: the token no longer works. Connect again at /api/google/connect.");
} else {
  console.log("\nGoogle Calendar: not connected");
}

function printIds(groups: Record<string, string[]>) {
  for (const [label, ids] of Object.entries(groups)) {
    console.log(`${label} (${ids.length})${ids.length > 0 ? ": " + ids.join(", ") : ""}`);
  }
}
