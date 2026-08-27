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

export interface PatchFileChange {
  path: string;
  before: string;
  after: string;
}

export interface CandidatePatch {
  files: PatchFileChange[];
}

export interface ValidationCommand {
  command: string;
  args?: string[];
  relativeCwd?: string;
  timeoutMs?: number;
  timeoutGraceMs?: number;
  maxOutputBytes?: number;
}

export interface PatchValidationInput {
  workspacePath: string;
  patch: CandidatePatch;
  reproductionCommand: ValidationCommand;
  expectedFailure: FailureFingerprint;
  setupCommand?: ValidationCommand;
  regressionCommand?: ValidationCommand;
  protectedPaths?: string[];
  workspaceCopyExcludes?: string[];
}

export interface PatchValidationResult {
  status: "patch-ready" | "patch-failed";
  setup?: CommandResult;
  before: ReproductionVerification;
  after: CommandResult;
  regressions?: CommandResult;
  filesChanged: string[];
  reason?: string;
}
