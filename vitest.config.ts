import { defineConfig } from "vitest/config";

export default defineConfig({
  test: {
    // Project is ESM (NodeNext), no JSX transforms needed for backend tests.
    globals: true,
    // in-memory SQLite means DB tests are isolated and deterministic.
    // No global setup file needed.
  },
});