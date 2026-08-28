import { describe, expect, it } from "vitest";
import { runDemo } from "../src/index.js";

describe("demo runner", () => {
  it("drives a safe issue through verified patch approval", async () => {
    const summary = await runDemo();

    expect(summary.safeIssueScan.safeToExecute).toBe(true);
    expect(summary.quarantinedIssueScan.safeToExecute).toBe(false);
    expect(summary.validation.status).toBe("patch-ready");
    expect(summary.validation.before.status).toBe("verified");
    expect(summary.validation.after.exitCode).toBe(0);
    expect(summary.validation.regressions?.exitCode).toBe(0);
    expect(summary.run.status).toBe("awaiting-approval");
  });
});
