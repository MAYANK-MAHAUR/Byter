import { mkdtemp, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { assertPatchDoesNotTouchProtectedPaths, validatePatch } from "../src/index.js";

let workspacePath: string;

beforeEach(async () => {
  workspacePath = await mkdtemp(join(tmpdir(), "reprosmith-validator-test-"));
  await writeFile(
    join(workspacePath, "parser.js"),
    [
      "export function parse(input) {",
      "  if (input === '\\\\') {",
      "    throw new TypeError('Cannot read properties of undefined');",
      "  }",
      "  return input;",
      "}"
    ].join("\n"),
    "utf8"
  );
  await writeFile(
    join(workspacePath, "repro.mjs"),
    ["import { parse } from './parser.js';", "parse('\\\\');"].join("\n"),
    "utf8"
  );
  await writeFile(
    join(workspacePath, "regression.mjs"),
    ["import { parse } from './parser.js';", "if (parse('ok') !== 'ok') process.exit(1);"].join("\n"),
    "utf8"
  );
  await writeFile(join(workspacePath, "package.json"), "{\"type\":\"module\"}\n", "utf8");
});

afterEach(async () => {
  await rm(workspacePath, { recursive: true, force: true });
});

describe("patch validator", () => {
  it("proves before fail, after pass, and regression pass", async () => {
    const result = await validatePatch({
      workspacePath,
      expectedFailure: {
        errorType: "TypeError",
        message: "Cannot read properties of undefined"
      },
      reproductionCommand: { command: process.execPath, args: ["repro.mjs"], timeoutMs: 5_000 },
      regressionCommand: { command: process.execPath, args: ["regression.mjs"], timeoutMs: 5_000 },
      protectedPaths: ["repro.mjs"],
      patch: {
        files: [
          {
            path: "parser.js",
            before: "throw new TypeError('Cannot read properties of undefined');",
            after: "return '';"
          }
        ]
      }
    });

    expect(result.status).toBe("patch-ready");
    expect(result.before.status).toBe("verified");
    expect(result.after.exitCode).toBe(0);
    expect(result.regressions?.exitCode).toBe(0);
  });

  it("rejects patches that modify protected reproducer files", () => {
    expect(() =>
      assertPatchDoesNotTouchProtectedPaths(
        { files: [{ path: "repro.mjs", before: "parse", after: "process.exit(0)" }] },
        ["repro.mjs"]
      )
    ).toThrow("protected reproducer path");
  });
});
