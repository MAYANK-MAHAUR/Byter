import { spawn } from "node:child_process";
import { performance } from "node:perf_hooks";
import type { CommandResult, CommandSpec } from "./types.js";

const allowedEnvKeys = new Set(["CI", "HOME", "PATH", "PATHEXT", "SHELL", "SystemRoot", "TEMP", "TMP", "USERPROFILE"]);

export async function runCommand(spec: CommandSpec): Promise<CommandResult> {
  const args = spec.args ?? [];
  const cwd = spec.cwd ?? process.cwd();
  const started = performance.now();

  return await new Promise((resolve, reject) => {
    const child = spawn(spec.command, args, {
      cwd,
      env: buildSafeEnv(spec.env),
      shell: false,
      windowsHide: true
    });

    let stdout = "";
    let stderr = "";
    let settled = false;
    let timedOut = false;
    const timeout = setTimeout(() => {
      timedOut = true;
      child.kill("SIGTERM");
    }, spec.timeoutMs ?? 30_000);

    child.stdout.setEncoding("utf8");
    child.stderr.setEncoding("utf8");
    child.stdout.on("data", (chunk) => {
      stdout += chunk;
    });
    child.stderr.on("data", (chunk) => {
      stderr += chunk;
    });
    child.on("error", (error) => {
      if (settled) {
        return;
      }
      settled = true;
      clearTimeout(timeout);
      reject(error);
    });
    child.on("close", (exitCode) => {
      if (settled) {
        return;
      }
      settled = true;
      clearTimeout(timeout);
      resolve({
        command: spec.command,
        args,
        cwd,
        exitCode,
        timedOut,
        durationMs: Math.round(performance.now() - started),
        stdout,
        stderr
      });
    });
  });
}

export function buildSafeEnv(overrides: Record<string, string | undefined> = {}): NodeJS.ProcessEnv {
  const env: NodeJS.ProcessEnv = {};

  for (const key of allowedEnvKeys) {
    if (process.env[key]) {
      env[key] = process.env[key];
    }
  }

  for (const [key, value] of Object.entries(overrides)) {
    if (value !== undefined) {
      env[key] = value;
    }
  }

  return env;
}
