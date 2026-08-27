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
    expect(result.outputLimitExceeded).toBe(false);
    expect(result.stdout.trim()).toBe("hello");
    expect(result.timedOut).toBe(false);
  });

  it("settles timed-out commands after the grace period", async () => {
    const result = await runCommand({
      command: process.execPath,
      args: ["-e", "process.on('SIGTERM', () => {}); setInterval(() => {}, 1000);"],
      timeoutMs: 100,
      timeoutGraceMs: 100
    });

    expect(result.timedOut).toBe(true);
    expect(result.exitCode).toBeNull();
  });

  it("bounds captured output and terminates noisy commands", async () => {
    const result = await runCommand({
      command: process.execPath,
      args: ["-e", "for (let i = 0; i < 10000; i++) process.stdout.write('x');"],
      maxOutputBytes: 128,
      timeoutMs: 5_000
    });

    expect(result.outputLimitExceeded).toBe(true);
    expect(result.outputTruncated).toBe(true);
    expect(Buffer.byteLength(result.stdout)).toBeLessThanOrEqual(128);
  });

  it("does not copy arbitrary host secrets into the runner env", () => {
    process.env.MODEL_API_KEY = "local-secret";

    expect(buildSafeEnv().MODEL_API_KEY).toBeUndefined();
  });
});
