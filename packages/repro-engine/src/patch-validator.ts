import { lstatSync } from "node:fs";
import { lstat, mkdtemp, readFile, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { isAbsolute, join, posix, relative, resolve } from "node:path";
import { extractFailureFingerprint, matchFingerprints } from "./fingerprint.js";
import { runCommand } from "./runner.js";
import type {
  CandidatePatch,
  CommandSpec,
  PatchFileChange,
  PatchValidationInput,
  PatchValidationResult,
  ValidationCommand
} from "./types.js";
import { verifyReproduction } from "./verifier.js";

export async function validatePatch(input: PatchValidationInput): Promise<PatchValidationResult> {
  assertPatchDoesNotTouchProtectedPaths(input.patch, input.protectedPaths ?? []);

  const tempWorkspace = await mkdtemp(join(tmpdir(), "reprosmith-patch-"));
  try {
    await copyWorkspace(input.workspacePath, tempWorkspace, input.workspaceCopyExcludes ?? [".git"]);

    const setup = input.setupCommand ? await runCommand(toCommandSpec(input.setupCommand, tempWorkspace)) : undefined;
    if (setup && !commandSucceeded(setup)) {
      const before = emptyVerification(input.expectedFailure);
      return {
        status: "patch-failed",
        setup,
        before,
        after: await notRunResult(input.reproductionCommand, tempWorkspace),
        filesChanged: input.patch.files.map((file) => canonicalRelativePath(file.path)),
        reason: "Setup command failed"
      };
    }

    const expectedFailure = remapExpectedFailure(input.expectedFailure, input.workspacePath, tempWorkspace);
    const before = await verifyReproduction({
      runs: 3,
      command: toCommandSpec(input.reproductionCommand, tempWorkspace),
      expected: expectedFailure
    });
    if (before.status !== "verified") {
      return {
        status: "patch-failed",
        ...(setup ? { setup } : {}),
        before,
        after: await notRunResult(input.reproductionCommand, tempWorkspace),
        filesChanged: input.patch.files.map((file) => canonicalRelativePath(file.path)),
        reason: "Before-patch reproduction did not verify the expected failure"
      };
    }

    await applyPatch(tempWorkspace, input.patch);

    const after = await runCommand(toCommandSpec(input.reproductionCommand, tempWorkspace));
    if (!commandSucceeded(after) || matchFingerprints(expectedFailure, extractFailureFingerprint(after))) {
      return {
        status: "patch-failed",
        ...(setup ? { setup } : {}),
        before,
        after,
        filesChanged: input.patch.files.map((file) => canonicalRelativePath(file.path)),
        reason: "After-patch reproduction still fails"
      };
    }

    const regressions = input.regressionCommand
      ? await runCommand(toCommandSpec(input.regressionCommand, tempWorkspace))
      : undefined;
    if (regressions && !commandSucceeded(regressions)) {
      return {
        status: "patch-failed",
        ...(setup ? { setup } : {}),
        before,
        after,
        regressions,
        filesChanged: input.patch.files.map((file) => canonicalRelativePath(file.path)),
        reason: "Regression command failed"
      };
    }

    return {
      status: "patch-ready",
      ...(setup ? { setup } : {}),
      before,
      after,
      ...(regressions ? { regressions } : {}),
      filesChanged: input.patch.files.map((file) => canonicalRelativePath(file.path))
    };
  } finally {
    await rm(tempWorkspace, { recursive: true, force: true });
  }
}

export function assertPatchDoesNotTouchProtectedPaths(patch: CandidatePatch, protectedPaths: string[]): void {
  const protectedSet = new Set(protectedPaths.map(canonicalRelativePath));

  for (const file of patch.files) {
    const patchPath = canonicalRelativePath(file.path);
    if ([...protectedSet].some((protectedPath) => patchPath === protectedPath || patchPath.startsWith(`${protectedPath}/`))) {
      throw new Error(`Patch modifies protected reproducer path: ${file.path}`);
    }
  }
}

async function applyPatch(workspacePath: string, patch: CandidatePatch): Promise<void> {
  for (const file of patch.files) {
    await applyFileChange(workspacePath, file);
  }
}

async function applyFileChange(workspacePath: string, change: PatchFileChange): Promise<void> {
  const target = resolveInside(workspacePath, change.path);
  await assertPathHasNoSymlinks(workspacePath, target);
  const current = await readFile(target, "utf8");
  if (!current.includes(change.before)) {
    throw new Error(`Patch context not found: ${change.path}`);
  }

  await writeFile(target, current.replace(change.before, change.after), "utf8");
}

async function copyWorkspace(source: string, target: string, excludedNames: string[]): Promise<void> {
  const { cp } = await import("node:fs/promises");
  const excluded = new Set(excludedNames);
  await cp(source, target, {
    recursive: true,
    filter: (path) => {
      const normalized = path.replace(/\\/g, "/");
      const baseName = normalized.split("/").at(-1);
      if (baseName && excluded.has(baseName)) {
        return false;
      }

      return !lstatSync(path).isSymbolicLink();
    }
  });
}

function toCommandSpec(command: ValidationCommand, workspacePath: string): CommandSpec {
  return {
    command: command.command,
    args: command.args,
    cwd: command.relativeCwd ? resolveInside(workspacePath, command.relativeCwd) : workspacePath,
    timeoutMs: command.timeoutMs,
    timeoutGraceMs: command.timeoutGraceMs,
    maxOutputBytes: command.maxOutputBytes
  };
}

async function notRunResult(command: ValidationCommand, workspacePath: string) {
  return {
    command: command.command,
    args: command.args ?? [],
    cwd: command.relativeCwd ? resolveInside(workspacePath, command.relativeCwd) : workspacePath,
    exitCode: null,
    timedOut: false,
    outputLimitExceeded: false,
    outputTruncated: false,
    durationMs: 0,
    stdout: "",
    stderr: "Not run"
  };
}

function resolveInside(root: string, relativePath: string): string {
  const normalized = canonicalRelativePath(relativePath);
  const rootPath = resolve(root);
  const target = resolve(rootPath, normalized);
  const targetRelativePath = relative(rootPath, target);
  if (targetRelativePath.startsWith("..") || isAbsolute(targetRelativePath)) {
    throw new Error(`Path escapes workspace: ${relativePath}`);
  }

  return target;
}

function canonicalRelativePath(path: string): string {
  const slashPath = path.replace(/\\/g, "/");
  if (slashPath.startsWith("/") || /^[A-Za-z]:\//.test(slashPath)) {
    throw new Error(`Invalid relative path: ${path}`);
  }

  const normalized = posix.normalize(slashPath);
  if (
    normalized === "." ||
    normalized === ".." ||
    normalized.startsWith("../") ||
    normalized.split("/").some((segment) => segment.length === 0)
  ) {
    throw new Error(`Invalid relative path: ${path}`);
  }

  return normalized;
}

async function assertPathHasNoSymlinks(root: string, target: string): Promise<void> {
  const rootPath = resolve(root);
  const targetRelativePath = relative(rootPath, target);
  let current = rootPath;

  for (const segment of targetRelativePath.split(/[\\/]/)) {
    current = resolve(current, segment);
    const stats = await lstat(current);
    if (stats.isSymbolicLink()) {
      throw new Error(`Patch target traverses a symbolic link: ${targetRelativePath}`);
    }
  }
}

function commandSucceeded(result: { exitCode: number | null; timedOut: boolean; outputLimitExceeded: boolean }): boolean {
  return result.exitCode === 0 && !result.timedOut && !result.outputLimitExceeded;
}

function emptyVerification(expected: PatchValidationInput["expectedFailure"]) {
  return {
    status: "not-reproduced" as const,
    attempts: [],
    expected
  };
}

function remapExpectedFailure(
  expected: PatchValidationInput["expectedFailure"],
  originalWorkspace: string,
  tempWorkspace: string
) {
  if (!expected.file || !isAbsolute(expected.file)) {
    return expected;
  }

  const originalRoot = resolve(originalWorkspace);
  const originalFile = resolve(expected.file);
  const relativeFile = relative(originalRoot, originalFile);
  if (relativeFile.startsWith("..") || isAbsolute(relativeFile)) {
    return expected;
  }

  return {
    ...expected,
    file: resolve(tempWorkspace, relativeFile)
  };
}
