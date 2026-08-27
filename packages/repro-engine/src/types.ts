export interface CommandSpec {
  command: string;
  args?: string[];
  cwd?: string;
  timeoutMs?: number;
  timeoutGraceMs?: number;
  maxOutputBytes?: number;
  env?: Record<string, string | undefined>;
}

export interface CommandResult {
  command: string;
  args: string[];
  cwd: string;
  exitCode: number | null;
  timedOut: boolean;
  outputLimitExceeded: boolean;
  outputTruncated: boolean;
  durationMs: number;
  stdout: string;
  stderr: string;
}

export interface FailureFingerprint {
  errorType: string;
  message: string;
  file?: string;
  line?: number;
  column?: number;
  stackFrame?: string;
}

export interface ReproductionAttempt {
  index: number;
  result: CommandResult;
  fingerprint: FailureFingerprint;
  matchedExpected: boolean;
}

export interface ReproductionVerification {
  status: "verified" | "flaky" | "not-reproduced";
  attempts: ReproductionAttempt[];
  expected: FailureFingerprint;
}

export interface MinimizationResult {
  originalLineCount: number;
  minimizedLineCount: number;
  source: string;
  removedLineNumbers: number[];
}
