import { defineConfig } from "vitest/config";

// Tests JS. Hoy solo cubren scripts/ (node puro, sin DOM). Si se agregan tests
// de src/ que necesiten DOM, ahi se cambia environment o se usa un config aparte.
export default defineConfig({
  test: {
    environment: "node",
    include: ["scripts/**/*.test.{js,mjs,cjs}"],
    passWithNoTests: false
  }
});
