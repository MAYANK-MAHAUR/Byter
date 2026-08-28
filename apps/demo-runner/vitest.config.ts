import { fileURLToPath } from "node:url";
import { defineConfig } from "vitest/config";

export default defineConfig({
  resolve: {
    alias: {
      "@reprosmith/core": fileURLToPath(new URL("../../packages/core/src/index.ts", import.meta.url)),
      "@reprosmith/repro-engine": fileURLToPath(new URL("../../packages/repro-engine/src/index.ts", import.meta.url))
    }
  }
});
