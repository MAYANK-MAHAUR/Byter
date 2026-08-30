import { fileURLToPath } from "node:url";
import { defineConfig } from "vitest/config";

export default defineConfig({
  resolve: {
    alias: {
      "@byter/core": fileURLToPath(new URL("../../packages/core/src/index.ts", import.meta.url)),
      "@byter/repro-engine": fileURLToPath(new URL("../../packages/repro-engine/src/index.ts", import.meta.url))
    }
  }
});
