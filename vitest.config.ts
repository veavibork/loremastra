import { defineConfig } from "vitest/config";

export default defineConfig({
  test: {
    globals: true,
    env: {
      APP_MASTER_KEY: "179e04c176207244d94c5c82cbf059afa80cc042e076d206758ab85a72d226b9",
    },
  },
});