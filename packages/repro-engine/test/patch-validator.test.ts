import { mkdir, mkdtemp, readFile, rm, symlink, writeFile } from "node:fs/promises";
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
      workspaceCopyExcludes: ["node_modules"],
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

  it("remaps original absolute stack paths into the temp validation workspace", async () => {
    const result = await validatePatch({
      workspacePath,
      expectedFailure: {
        errorType: "TypeError",
        message: "Cannot read properties of undefined",
        file: join(workspacePath, "parser.js"),
        line: 3
      },
      reproductionCommand: { command: process.execPath, args: ["repro.mjs"], timeoutMs: 5_000 },
      protectedPaths: ["repro.mjs"],
      workspaceCopyExcludes: ["node_modules"],
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
  });

  it("rejects patches that modify protected reproducer files", () => {
    expect(() =>
      assertPatchDoesNotTouchProtectedPaths(
        { files: [{ path: "repro.mjs", before: "parse", after: "process.exit(0)" }] },
        ["repro.mjs"]
      )
    ).toThrow("protected reproducer path");
  });

  it("rejects protected path aliases", () => {
    expect(() =>
      assertPatchDoesNotTouchProtectedPaths(
        { files: [{ path: "./nested/../repro.mjs", before: "parse", after: "process.exit(0)" }] },
        ["repro.mjs"]
      )
    ).toThrow("protected reproducer path");
  });

  it("rejects patch targets that traverse copied symlinks", async () => {
    const outsidePath = join(tmpdir(), `reprosmith-outside-${Date.now()}.txt`);
    await writeFile(outsidePath, "secret", "utf8");
    try {
      await symlink(outsidePath, join(workspacePath, "linked.txt"));
    } catch {
      await rm(outsidePath, { force: true });
      return;
    }

    await expect(
      validatePatch({
        workspacePath,
        expectedFailure: {
          errorType: "TypeError",
          message: "Cannot read properties of undefined"
        },
        reproductionCommand: { command: process.execPath, args: ["repro.mjs"], timeoutMs: 5_000 },
        workspaceCopyExcludes: ["node_modules"],
        patch: {
          files: [{ path: "linked.txt", before: "secret", after: "changed" }]
        }
      })
    ).rejects.toThrow();

    await expect(readFile(outsidePath, "utf8")).resolves.toBe("secret");
    await rm(outsidePath, { force: true });
  });

  it("preserves dependency directories unless explicitly excluded", async () => {
    await mkdir(join(workspacePath, "node_modules", "fixture"), { recursive: true });
    await writeFile(join(workspacePath, "node_modules", "fixture", "index.js"), "module.exports = 42;\n", "utf8");
    await writeFile(
      join(workspacePath, "regression.mjs"),
      "if ((await import('./node_modules/fixture/index.js')).default !== 42) process.exit(1);\n",
      "utf8"
    );

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
  });

  it("rejects post-patch commands terminated by output limits", async () => {
    const result = await validatePatch({
      workspacePath,
      expectedFailure: {
        errorType: "TypeError",
        message: "Cannot read properties of undefined"
      },
      reproductionCommand: { command: process.execPath, args: ["repro.mjs"], timeoutMs: 5_000, maxOutputBytes: 256 },
      protectedPaths: ["repro.mjs"],
      workspaceCopyExcludes: ["node_modules"],
      patch: {
        files: [
          {
            path: "parser.js",
            before: "throw new TypeError('Cannot read properties of undefined');",
            after: "for (let index = 0; index < 1000; index += 1) process.stdout.write('x'); return '';"
          }
        ]
      }
    });

    expect(result.status).toBe("patch-failed");
    expect(result.after.outputLimitExceeded).toBe(true);
  });
});
