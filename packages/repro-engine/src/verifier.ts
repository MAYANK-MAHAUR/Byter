import { extractFailureFingerprint, matchFingerprints } from "./fingerprint.js";
import { runCommand } from "./runner.js";
import type { CommandSpec, FailureFingerprint, ReproductionAttempt, ReproductionVerification } from "./types.js";

export interface VerifyReproductionOptions {
  command: CommandSpec;
  expected: FailureFingerprint;
  runs?: number;
}

export async function verifyReproduction(options: VerifyReproductionOptions): Promise<ReproductionVerification> {
  const runs = options.runs ?? 3;
  const attempts: ReproductionAttempt[] = [];

  for (let index = 1; index <= runs; index += 1) {
    const result = await runCommand(options.command);
    const fingerprint = extractFailureFingerprint(result);
    attempts.push({
      index,
      result,
      fingerprint,
      matchedExpected: result.exitCode !== 0 && matchFingerprints(options.expected, fingerprint)
    });
  }

  const matches = attempts.filter((attempt) => attempt.matchedExpected).length;
  const status = matches === runs ? "verified" : matches > 0 ? "flaky" : "not-reproduced";

  return {
    status,
    attempts,
    expected: options.expected
  };
}
