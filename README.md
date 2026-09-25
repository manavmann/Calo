# Calo
Syncs Canvas due dates to Google, Apple, and Notion Calendar.

## Run it locally

Needs Node 24+, pnpm, and Docker.

```sh
pnpm install
docker compose up -d                      # Postgres on localhost:5432
cp apps/api/.env.example apps/api/.env
pnpm --filter @calo/api db:push           # create the tables from the Drizzle schema
pnpm --filter @calo/api dev               # API on http://localhost:3000
```

Until Google sign-in exists, get a session from the dev script. It only runs
against a database on localhost.

```sh
pnpm --filter @calo/api dev:session you@sfu.ca
```

It prints a `calo_session` cookie to add in devtools for http://localhost:3000,
plus a ready-to-run curl command. `pnpm --filter @calo/api db:studio` opens a
browser view of the database.
