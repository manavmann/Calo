import { serve } from "@hono/node-server";
import { Hono } from "hono";
import { deleteCookie, getCookie } from "hono/cookie";
import {
  invalidateSession,
  requireSession,
  SESSION_COOKIE,
  SESSION_COOKIE_OPTIONS,
} from "./session.ts";

const app = new Hono();

app.get("/api/me", requireSession, (c) => {
  const user = c.get("user");
  return c.json({ id: user.id, email: user.email });
});

// Not behind requireSession, so an expired cookie still gets cleared.
app.post("/api/logout", async (c) => {
  const token = getCookie(c, SESSION_COOKIE);
  if (token) {
    await invalidateSession(token);
  }
  deleteCookie(c, SESSION_COOKIE, SESSION_COOKIE_OPTIONS);
  return c.body(null, 204);
});

serve({ fetch: app.fetch, port: 3000 }, (info) => {
  console.log(`API listening on http://localhost:${info.port}`);
});
