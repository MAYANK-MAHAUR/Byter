import { mkdtemp, readFile, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join, resolve } from "node:path";
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
    await copyWorkspace(input.workspacePath, tempWorkspace);

    const before = await verifyReproduction({
      runs: 3,
      command: toCommandSpec(input.reproductionCommand, tempWorkspace),
      expected: input.expectedFailure
    });
    if (before.status !== "verified") {
      return {
        status: "patch-failed",
        before,
        after: await notRunResult(input.reproductionCommand, tempWorkspace),
        filesChanged: input.patch.files.map((file) => file.path),
        reason: "Before-patch reproduction did not verify the expected failure"
      };
    }

    await applyPatch(tempWorkspace, input.patch);

    const after = await runCommand(toCommandSpec(input.reproductionCommand, tempWorkspace));
    if (after.exitCode !== 0 || matchFingerprints(input.expectedFailure, extractFailureFingerprint(after))) {
      return {
        status: "patch-failed",
        before,
        after,
        filesChanged: input.patch.files.map((file) => file.path),
        reason: "After-patch reproduction still fails"
      };
    }

    const regressions = input.regressionCommand
      ? await runCommand(toCommandSpec(input.regressionCommand, tempWorkspace))
      : undefined;
    if (regressions && regressions.exitCode !== 0) {
      return {
        status: "patch-failed",
        before,
        after,
        regressions,
        filesChanged: input.patch.files.map((file) => file.path),
        reason: "Regression command failed"
      };
    }

    return {
      status: "patch-ready",
      before,
      after,
      ...(regressions ? { regressions } : {}),
      filesChanged: input.patch.files.map((file) => file.path)
    };
  } finally {
    await rm(tempWorkspace, { recursive: true, force: true });
  }
}

export function assertPatchDoesNotTouchProtectedPaths(patch: CandidatePatch, protectedPaths: string[]): void {
  const protectedSet = new Set(protectedPaths.map(normalizeRelativePath));

  for (const file of patch.files) {
    if (protectedSet.has(normalizeRelativePath(file.path))) {
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
  const current = await readFile(target, "utf8");
  if (!current.includes(change.before)) {
    throw new Error(`Patch context not found: ${change.path}`);
  }

  await writeFile(target, current.replace(change.before, change.after), "utf8");
}

async function copyWorkspace(source: string, target: string): Promise<void> {
  const { cp } = await import("node:fs/promises");
  await cp(source, target, {
    recursive: true,
    filter: (path) => {
      const normalized = path.replace(/\\/g, "/");
      return !/(^|\/)(node_modules|dist|\.git)(\/|$)/.test(normalized);
    }
  });
}

function toCommandSpec(command: ValidationCommand, workspacePath: string): CommandSpec {
  return {
    command: command.command,
    args: command.args,
    cwd: command.relativeCwd ? resolveInside(workspacePath, command.relativeCwd) : workspacePath,
    timeoutMs: command.timeoutMs
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
  const normalized = normalizeRelativePath(relativePath);
  const rootPath = resolve(root);
  const target = resolve(rootPath, normalized);
  if (target !== rootPath && !target.startsWith(`${rootPath}\\`) && !target.startsWith(`${rootPath}/`)) {
    throw new Error(`Path escapes workspace: ${relativePath}`);
  }

  return target;
}

function normalizeRelativePath(path: string): string {
  const normalized = path.replace(/\\/g, "/");
  if (normalized.startsWith("/") || normalized.split("/").some((segment) => segment === "..")) {
    throw new Error(`Invalid relative path: ${path}`);
  }

  return normalized;
}
