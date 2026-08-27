import { describe, expect, it } from "vitest";
import { buildSafeEnv, runCommand } from "../src/index.js";

describe("command runner", () => {
  it("executes a command and captures output", async () => {
    const result = await runCommand({
      command: process.execPath,
      args: ["-e", "console.log('hello')"],
      timeoutMs: 5_000
    });

    expect(result.exitCode).toBe(0);
    expect(result.stdout.trim()).toBe("hello");
    expect(result.timedOut).toBe(false);
  });

  it("does not copy arbitrary host secrets into the runner env", () => {
    process.env.MODEL_API_KEY = "local-secret";

    expect(buildSafeEnv().MODEL_API_KEY).toBeUndefined();
  });
});
