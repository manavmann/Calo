import { fileURLToPath } from "node:url";
import { defineConfig } from "vitest/config";

export default defineConfig({
  resolve: {
    alias: {
      // Core's source rather than its built dist/, so these tests can't pass
      // or fail on a build that's out of date.
      "@calo/core": fileURLToPath(new URL("../../packages/core/src/index.ts", import.meta.url)),
    },
  },
  test: {
    // Set here instead of read from .env, so tests can't reach the dev
    // database or use a real key or OAuth client. The Google values are never
    // sent anywhere: fake-network.ts answers for Google.
    env: {
      DATABASE_URL: "postgres://calo:calo@localhost:5432/calo_test",
      ENCRYPTION_KEY: "0123456789abcdef".repeat(4),
      GOOGLE_CLIENT_ID: "test-client-id",
      GOOGLE_CLIENT_SECRET: "test-client-secret",
      GOOGLE_REDIRECT_URI: "http://localhost:3000/api/google/callback",
    },
    globalSetup: "src/test-db.ts",
  },
});
