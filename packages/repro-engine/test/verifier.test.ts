import { describe, expect, it } from "vitest";
import { verifyReproduction } from "../src/index.js";

describe("reproduction verifier", () => {
  it("requires the same target failure in every run", async () => {
    const verification = await verifyReproduction({
      runs: 3,
      command: {
        command: process.execPath,
        args: ["-e", "throw new TypeError('Cannot read properties of undefined')"],
        timeoutMs: 5_000
      },
      expected: {
        errorType: "TypeError",
        message: "Cannot read properties of undefined"
      }
    });

    expect(verification.status).toBe("verified");
    expect(verification.attempts).toHaveLength(3);
    expect(verification.attempts.every((attempt) => attempt.matchedExpected)).toBe(true);
  });

  it("classifies a passing command as not reproduced", async () => {
    const verification = await verifyReproduction({
      runs: 2,
      command: {
        command: process.execPath,
        args: ["-e", "console.log('pass')"],
        timeoutMs: 5_000
      },
      expected: {
        errorType: "TypeError",
        message: "Cannot read properties of undefined"
      }
    });

    expect(verification.status).toBe("not-reproduced");
  });

  it.each([0, -1, 1.5, Number.NaN, Number.POSITIVE_INFINITY])(
    "rejects invalid run count %s",
    async (runs) => {
      await expect(
        verifyReproduction({
          runs,
          command: {
            command: process.execPath,
            args: ["-e", "console.log('unused')"],
            timeoutMs: 5_000
          },
          expected: {
            errorType: "TypeError",
            message: "Cannot read properties of undefined"
          }
        })
      ).rejects.toThrow("positive integer");
    }
  );
});
