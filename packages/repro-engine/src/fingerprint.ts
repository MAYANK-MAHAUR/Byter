import type { CommandResult, FailureFingerprint } from "./types.js";

export function extractFailureFingerprint(result: CommandResult): FailureFingerprint {
  const output = `${result.stderr}\n${result.stdout}`.trim();
  const lines = output.split(/\r?\n/).map((line) => line.trim());
  const firstLine = lines.find((line) => line.length > 0) ?? "";
  const errorLine = lines.find((line) => /^[A-Za-z][A-Za-z0-9_.]*Error:\s+/.test(line)) ?? firstLine;
  const errorMatch = errorLine.match(/^([A-Za-z][A-Za-z0-9_.]*Error):\s*(.+)$/);
  const location = extractStackLocation(output);

  return {
    errorType: result.timedOut ? "TimeoutError" : errorMatch?.[1] ?? "CommandFailure",
    message: normalizeMessage(errorMatch?.[2] ?? firstLine),
    ...location
  };
}

export function matchFingerprints(expected: FailureFingerprint, actual: FailureFingerprint): boolean {
  if (expected.errorType !== actual.errorType) {
    return false;
  }

  const expectedMessage = normalizeMessage(expected.message);
  const actualMessage = normalizeMessage(actual.message);
  if (!expectedMessage || !actualMessage) {
    return expectedMessage === actualMessage;
  }

  const messageMatches =
    expectedMessage === actualMessage ||
    expectedMessage.includes(actualMessage) ||
    actualMessage.includes(expectedMessage);

  if (!messageMatches) {
    return false;
  }

  if (expected.file) {
    if (!actual.file || normalizePath(expected.file) !== normalizePath(actual.file)) {
      return false;
    }
  }

  if (expected.line !== undefined) {
    if (actual.line === undefined || expected.line !== actual.line) {
      return false;
    }
  }

  if (expected.column !== undefined) {
    if (actual.column === undefined || expected.column !== actual.column) {
      return false;
    }
  }

  if (expected.stackFrame !== undefined) {
    if (actual.stackFrame === undefined || expected.stackFrame !== actual.stackFrame) {
      return false;
    }
  }

  return true;
}

function extractStackLocation(output: string): Partial<FailureFingerprint> {
  const stackLine = output.split(/\r?\n/).find((line) => /\bat\b/.test(line) && /:\d+:\d+\)?$/.test(line));
  if (!stackLine) {
    return {};
  }

  const match = stackLine.match(/at\s+(?:async\s+)?(?:(.+?)\s+\()?(?:file:\/\/\/)?(.+):(\d+):(\d+)\)?$/);
  if (!match) {
    return {};
  }

  return {
    stackFrame: match[1]?.trim(),
    file: normalizeStackFile(match[2]?.trim() ?? "", stackLine),
    line: Number.parseInt(match[3] ?? "", 10),
    column: Number.parseInt(match[4] ?? "", 10)
  };
}

function normalizeStackFile(file: string, stackLine: string): string {
  if (stackLine.includes("file:///") && !file.startsWith("/") && !/^[A-Za-z]:/.test(file)) {
    return `/${file}`;
  }

  return file;
}

function normalizeMessage(message: string): string {
  return message.replace(/\s+/g, " ").trim();
}

function normalizePath(path: string): string {
  return path.replace(/\\/g, "/").replace(/^file:\/\/\//, "");
}
