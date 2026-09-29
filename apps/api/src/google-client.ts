import type { GoogleClient } from "@calo/core";

const { GOOGLE_CLIENT_ID, GOOGLE_CLIENT_SECRET, GOOGLE_REDIRECT_URI } = process.env;
if (!GOOGLE_CLIENT_ID || !GOOGLE_CLIENT_SECRET || !GOOGLE_REDIRECT_URI) {
  throw new Error(
    "GOOGLE_CLIENT_ID, GOOGLE_CLIENT_SECRET, and GOOGLE_REDIRECT_URI must be set. See the README.",
  );
}

// The redirect URI is configured rather than built from the request's Host
// header: Google only accepts the exact URI registered for the client, and
// Host is whatever the browser or a proxy in front of the API sent.
export const googleClient: GoogleClient = {
  id: GOOGLE_CLIENT_ID,
  secret: GOOGLE_CLIENT_SECRET,
  redirectUri: GOOGLE_REDIRECT_URI,
};
