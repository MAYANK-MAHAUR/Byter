import { describe, expect, it } from "vitest";
import { extractFailureFingerprint, matchFingerprints } from "../src/index.js";

describe("failure fingerprints", () => {
  it("extracts error type, message, and stack location", () => {
    const fingerprint = extractFailureFingerprint({
      command: "node",
      args: [],
      cwd: process.cwd(),
      exitCode: 1,
      timedOut: false,
      durationMs: 1,
      stdout: "",
      stderr: "TypeError: Cannot read properties of undefined\n    at tokenize (C:\\repo\\src\\tokenizer.ts:42:9)"
    });

    expect(fingerprint).toMatchObject({
      errorType: "TypeError",
      message: "Cannot read properties of undefined",
      file: "C:\\repo\\src\\tokenizer.ts",
      line: 42,
      column: 9,
      stackFrame: "tokenize"
    });
  });

  it("does not match different source lines", () => {
    expect(
      matchFingerprints(
        { errorType: "TypeError", message: "Cannot read properties", file: "src/tokenizer.ts", line: 3 },
        { errorType: "TypeError", message: "Cannot read properties", file: "src/tokenizer.ts", line: 9 }
      )
    ).toBe(false);
  });
});
