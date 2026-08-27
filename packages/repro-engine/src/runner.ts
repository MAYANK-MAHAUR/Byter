import { spawn } from "node:child_process";
import { performance } from "node:perf_hooks";
import type { CommandResult, CommandSpec } from "./types.js";

const allowedEnvKeys = new Set(["CI", "HOME", "PATH", "PATHEXT", "SHELL", "SystemRoot", "TEMP", "TMP", "USERPROFILE"]);
const defaultOutputLimitBytes = 1024 * 1024;

export async function runCommand(spec: CommandSpec): Promise<CommandResult> {
  const args = spec.args ?? [];
  const cwd = spec.cwd ?? process.cwd();
  const started = performance.now();
  const maxOutputBytes = spec.maxOutputBytes ?? defaultOutputLimitBytes;

  return await new Promise((resolve, reject) => {
    const child = spawn(spec.command, args, {
      cwd,
      env: buildSafeEnv(spec.env),
      detached: process.platform !== "win32",
      shell: false,
      windowsHide: true
    });

    let stdout = "";
    let stderr = "";
    let settled = false;
    let timedOut = false;
    let outputLimitExceeded = false;
    let outputTruncated = false;
    let stdoutBytes = 0;
    let stderrBytes = 0;
    let forceTimer: NodeJS.Timeout | undefined;

    const settle = (exitCode: number | null) => {
      if (settled) {
        return;
      }
      settled = true;
      clearTimeout(timeout);
      if (forceTimer) {
        clearTimeout(forceTimer);
      }
      resolve({
        command: spec.command,
        args,
        cwd,
        exitCode,
        timedOut,
        outputLimitExceeded,
        outputTruncated,
        durationMs: Math.round(performance.now() - started),
        stdout,
        stderr
      });
    };

    const requestTermination = (force: boolean) => {
      if (child.pid === undefined) {
        return;
      }

      if (process.platform === "win32") {
        const taskkillArgs = ["/pid", String(child.pid), "/T", force ? "/F" : ""].filter(Boolean);
        spawn("taskkill", taskkillArgs, { windowsHide: true }).on("error", () => undefined);
        return;
      }

      try {
        process.kill(-child.pid, force ? "SIGKILL" : "SIGTERM");
      } catch {
        child.kill(force ? "SIGKILL" : "SIGTERM");
      }
    };

    const timeout = setTimeout(() => {
      timedOut = true;
      requestTermination(false);
      forceTimer = setTimeout(() => {
        requestTermination(true);
        settle(null);
      }, spec.timeoutGraceMs ?? 1_000);
    }, spec.timeoutMs ?? 30_000);

    child.stdout.setEncoding("utf8");
    child.stderr.setEncoding("utf8");
    child.stdout.on("data", (chunk) => {
      const captured = appendBounded(stdout, stdoutBytes, chunk, maxOutputBytes);
      stdout = captured.value;
      stdoutBytes = captured.bytes;
      outputTruncated = outputTruncated || captured.truncated;
      if (captured.truncated) {
        outputLimitExceeded = true;
        requestTermination(false);
      }
    });
    child.stderr.on("data", (chunk) => {
      const captured = appendBounded(stderr, stderrBytes, chunk, maxOutputBytes);
      stderr = captured.value;
      stderrBytes = captured.bytes;
      outputTruncated = outputTruncated || captured.truncated;
      if (captured.truncated) {
        outputLimitExceeded = true;
        requestTermination(false);
      }
    });
    child.on("error", (error) => {
      if (settled) {
        return;
      }
      settled = true;
      clearTimeout(timeout);
      if (forceTimer) {
        clearTimeout(forceTimer);
      }
      reject(error);
    });
    child.on("close", (exitCode) => {
      settle(exitCode);
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

function appendBounded(current: string, currentBytes: number, chunk: string, maxBytes: number) {
  const chunkBytes = Buffer.byteLength(chunk);

  if (currentBytes + chunkBytes <= maxBytes) {
    return {
      value: current + chunk,
      bytes: currentBytes + chunkBytes,
      truncated: false
    };
  }

  const remaining = Math.max(0, maxBytes - currentBytes);
  let suffix = "";
  let bytes = 0;
  for (const char of chunk) {
    const charBytes = Buffer.byteLength(char);
    if (bytes + charBytes > remaining) {
      break;
    }
    suffix += char;
    bytes += charBytes;
  }

  return {
    value: current + suffix,
    bytes: currentBytes + bytes,
    truncated: true
  };
}
