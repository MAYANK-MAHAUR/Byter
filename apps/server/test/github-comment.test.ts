import { describe, expect, it } from "vitest";
import { buildGitHubStatusComment } from "../src/server.js";

function record(status: string, result?: Record<string, unknown>) {
  return {
    repository: "owner/repo",
    baseBranch: "main",
    issueTitle: "Tokenizer mishandles escaped uppercase literals",
    issueBody: "\\A becomes a.",
    dashboardUrl: "https://reprosmith.test/runs/run-25",
    run: { id: "run-25", status, issue: { owner: "owner", repo: "repo", issueNumber: 25 } },
    scan: { safeToExecute: true, findings: [] },
    trueForge: { status: status === "triaging" ? "started" : "completed", session: { id: "session-25" }, result }
  } as any;
}

const patch = {
  title: "Preserve escaped literal case",
  body: "Keep escaped characters unchanged.",
  files: [{ path: "src/tokenizer.ts", content: "secret should stay on the dashboard" }],
  hash: "a".repeat(64),
  baseBranch: "main",
  branchName: "reprosmith/fix-25",
  verifiedAt: "2026-08-30T00:00:00.000Z"
};

describe("GitHub status comment rendering", () => {
  it.each([
    ["triaging", "Investigating"],
    ["awaiting-approval", "Patch ready for review"],
    ["pr-created", "Fix proposed"],
    ["failed", "Run failed"]
  ])("renders the %s state as a concise status comment", (status, label) => {
    const body = buildGitHubStatusComment(record(status, status === "failed" ? undefined : {
      status: "patch-ready",
      summary: "The failure was reproduced.",
      rootCauseSummary: "The escape branch changes the literal case.",
      proposedFixSummary: "Preserve the escaped character before writing the patch.",
      proof: { before: "3/3 failed", after: "3/3 passed", regressions: "3/3 passed", attempts: "3/3" },
      candidatePatch: patch,
      ...(status === "pr-created" ? { pullRequest: { number: 42, url: "https://github.test/pull/42" } } : {})
    }), status === "triaging" ? "started" : status === "failed" ? "failed" : status === "pr-created" ? "approval" : "completed");
    expect(body).toContain(`## ReproSmith · ${label}`);
    expect(body).toContain("Issue #25");
    expect(body).not.toContain("secret should stay on the dashboard");
    expect(body).not.toContain("/reprosmith approve");
  });

  it("puts the direct review CTA on the paused patch state", () => {
    const body = buildGitHubStatusComment(record("awaiting-approval", {
      status: "patch-ready",
      summary: "The failure was reproduced.",
      rootCauseSummary: "The escape branch changes the literal case.",
      proposedFixSummary: "Preserve the escaped character.",
      proof: { before: "3/3 failed", after: "3/3 passed", regressions: "3/3 passed", attempts: "3/3" },
      candidatePatch: patch
    }), "completed");
    expect(body).toContain("https://reprosmith.test/runs/run-25/review");
    expect(body).toContain("TrueForge is paused");
    expect(body).toContain("Technical details");
  });
});
