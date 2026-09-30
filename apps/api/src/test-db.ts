// Vitest's global setup (see vitest.config.ts): runs once before any test
// file. Recreates the test database from schema.ts, so every run starts empty,
// with tables that match the current schema.
import { execFileSync } from "node:child_process";
import { fileURLToPath } from "node:url";
import postgres from "postgres";
import type { TestProject } from "vitest/node";

export default async function setup(project: TestProject) {
  const url = new URL(project.config.env.DATABASE_URL!);
  const name = url.pathname.slice(1);
  // This drops the database, so it refuses one that isn't clearly for tests.
  if (!name.endsWith("_test")) {
    throw new Error(`Refusing to recreate ${name}: the test database's name must end in _test.`);
  }

  // A database can't be dropped or created from a connection to itself.
  const maintenance = new URL(url);
  maintenance.pathname = "/postgres";
  const admin = postgres(maintenance.href, { onnotice: () => {} });
  await admin`drop database if exists ${admin(name)} with (force)`;
  await admin`create database ${admin(name)}`;
  await admin.end();

  // The same `drizzle-kit push` as db:push, but given the URL directly, so it
  // doesn't read drizzle.config.ts and the dev database in .env. (drizzle-kit's
  // pushSchema API would avoid a child process, but fails in 0.31.11.)
  const drizzleKit = fileURLToPath(new URL("../node_modules/drizzle-kit/bin.cjs", import.meta.url));
  execFileSync(
    process.execPath,
    [
      drizzleKit,
      "push",
      "--dialect=postgresql",
      "--schema=./src/schema.ts",
      `--url=${url.href}`,
      "--force",
    ],
    { cwd: fileURLToPath(new URL("..", import.meta.url)), stdio: "pipe" },
  );
}
