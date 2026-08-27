import { describe, expect, it } from "vitest";
import { createRun, transitionRun } from "../src/index.js";

const issue = {
  owner: "MAYANK-MAHAUR",
  repo: "Byter",
  issueNumber: 1,
  url: "https://github.com/MAYANK-MAHAUR/Byter/issues/1"
};

describe("ReproSmith state machine", () => {
  it("records a received issue and valid next event", () => {
    const run = createRun("run_1", issue, new Date("2026-08-27T10:00:00.000Z"));
    const next = transitionRun(run, "security-review", "Scanning issue text");

    expect(next.status).toBe("security-review");
    expect(next.events).toHaveLength(2);
    expect(next.events[1]?.message).toBe("Scanning issue text");
  });

  it("rejects unearned green states", () => {
    const run = createRun("run_1", issue);

    expect(() => transitionRun(run, "verified", "Trust me")).toThrow(
      "Invalid ReproSmith transition: received -> verified"
    );
  });
});
