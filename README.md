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

The API won't start until `.env` has a Google OAuth client. See
[Google Calendar](#google-calendar) below for setting one up.

Until Google sign-in exists, get a session from the dev script. It only runs
against a database on localhost.

```sh
pnpm --filter @calo/api dev:session you@sfu.ca
```

It prints a `calo_session` cookie to add in devtools for http://localhost:3000,
plus a ready-to-run curl command. `pnpm --filter @calo/api db:studio` opens a
browser view of the database.

Once that user has connected Canvas, pull their events into the database:

```sh
pnpm --filter @calo/api sync you@sfu.ca
```

If they've connected Google Calendar, the same command then writes the events
to a "Calo" calendar in their Google account.

## Google Calendar

Calo writes to a calendar it creates in the student's Google account, using the
`calendar.app.created` scope: it can't see or change their other calendars. To
set up an OAuth client for local development, in the
[Google Cloud console](https://console.cloud.google.com/):

1. Create a project, and enable the **Google Calendar API** for it
   (APIs & Services > Library).
2. Under **Google Auth Platform**, set up the app with audience **External**.
   Under **Audience**, add the Google account you'll connect as a test user.
   Under **Data Access**, add the scope
   `https://www.googleapis.com/auth/calendar.app.created`.
3. Under **Clients**, create a **Web application** client with the authorized
   redirect URI `http://localhost:3000/api/google/callback`, and put its ID and
   secret in `apps/api/.env`.

Then, in the browser that has the `calo_session` cookie, open
http://localhost:3000/api/google/connect and allow access. The next
`sync` makes the calendar and fills it in.

While the app's publishing status is **Testing**, only its test users can
connect, and Google expires their refresh tokens after 7 days. `sync` then
reports that the token no longer works; open `/api/google/connect` again.
