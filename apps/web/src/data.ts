import type { ReproRun, RunStatus, SecurityScanResult } from "@reprosmith/core";

export type EvidenceKind = "stdout" | "stack" | "patch" | "policy";
export type ApprovalActionId = "approve-pr" | "request-diff" | "reject-run";

export interface EvidenceItem {
  id: string;
  kind: EvidenceKind;
  title: string;
  value: string;
  detail: string;
  status: "verified" | "warning" | "blocked";
}

export interface ApprovalAction {
  id: ApprovalActionId;
  label: string;
  description: string;
  impact: "safe" | "review" | "blocked";
}

export interface QuarantinedReport {
  id: string;
  issueNumber: number;
  title: string;
  security: SecurityScanResult;
}

export interface DashboardRun extends ReproRun {
  repoLabel: string;
  issueTitle: string;
  assignee: string;
  runtime: string;
  model: string;
  currentBranch: string;
  candidatePatch: {
    title: string;
    files: string[];
    hash: string;
    verifiedAt: string;
  };
  evidence: EvidenceItem[];
  approvals: ApprovalAction[];
  security: SecurityScanResult;
  quarantinedReports: QuarantinedReport[];
}

const issue = {
  owner: "MAYANK-MAHAUR",
  repo: "Byter",
  issueNumber: 17,
  url: "https://github.com/MAYANK-MAHAUR/Byter/issues/17",
  baseSha: "814cf16"
};

const events: DashboardRun["events"] = [
  event("run-5:received", "received", "GitHub issue received", "2026-08-27T16:54:20.000Z"),
  event("run-5:security", "security-review", "Issue body passed command-risk scan", "2026-08-27T16:54:34.000Z", {
    findings: 0
  }),
  event("run-5:triaging", "triaging", "Agent extracted parser crash scenario", "2026-08-27T16:55:12.000Z"),
  event("run-5:environment", "environment-building", "Workspace copied with dependency cache intact", "2026-08-27T16:56:01.000Z"),
  event("run-5:reproducing", "reproducing", "Reproducer executed across 3 attempts", "2026-08-27T16:56:48.000Z", {
    attempts: 3
  }),
  event("run-5:verified", "verified", "Same TypeError fingerprint verified", "2026-08-27T16:57:23.000Z", {
    errorType: "TypeError",
    file: "parser.js:3"
  }),
  event("run-5:minimizing", "minimizing", "Input reduced to a single escape token", "2026-08-27T16:58:10.000Z"),
  event("run-5:fixing", "fixing", "Candidate replacement prepared", "2026-08-27T16:59:52.000Z"),
  event("run-5:validating", "validating", "Patch validation ran in disposable workspace", "2026-08-27T17:02:18.000Z"),
  event("run-5:ready", "patch-ready", "Before failed, after passed, regressions passed", "2026-08-27T17:03:42.000Z"),
  event("run-5:approval", "awaiting-approval", "GitHub write approval is required", "2026-08-27T17:04:05.000Z")
];

export const demoRun: DashboardRun = {
  id: "run-5",
  issue,
  repoLabel: "MAYANK-MAHAUR / Byter",
  issueTitle: "Tokenizer crashes on escaped slash input",
  assignee: "ReproSmith agent",
  runtime: "TrueForge Agent Harness",
  model: "AgentRouter glm-5.3",
  currentBranch: "feat/patch-validation",
  status: "awaiting-approval",
  createdAt: events[0]?.at ?? "2026-08-27T16:54:20.000Z",
  updatedAt: events.at(-1)?.at ?? "2026-08-27T17:04:05.000Z",
  events,
  candidatePatch: {
    title: "Harden patch validation workspace boundaries",
    files: ["packages/repro-engine/src/patch-validator.ts", "packages/repro-engine/src/types.ts"],
    hash: "9127d64",
    verifiedAt: "2026-08-27T17:18:10.000Z"
  },
  evidence: [
    {
      id: "ev-1",
      kind: "stack",
      title: "Failure fingerprint",
      value: "TypeError / parser.js:3",
      detail: "Matched across 3 consecutive runs",
      status: "verified"
    },
    {
      id: "ev-2",
      kind: "stdout",
      title: "Runner result",
      value: "exit 0 after patch",
      detail: "No timeout or output-limit flags",
      status: "verified"
    },
    {
      id: "ev-3",
      kind: "patch",
      title: "Files changed",
      value: "2 source files",
      detail: "Protected reproducer path untouched",
      status: "verified"
    },
    {
      id: "ev-4",
      kind: "policy",
      title: "Security scan",
      value: "0 findings",
      detail: "Run cleared for sandbox execution",
      status: "verified"
    }
  ],
  approvals: [
    {
      id: "approve-pr",
      label: "Approve PR write",
      description: "Create the verified fix PR with a payload-specific approval hash.",
      impact: "safe"
    },
    {
      id: "request-diff",
      label: "Request diff review",
      description: "Hold the write and send evidence to the maintainer queue.",
      impact: "review"
    },
    {
      id: "reject-run",
      label: "Reject run",
      description: "Close the run without mutating GitHub state.",
      impact: "blocked"
    }
  ],
  security: {
    safeToExecute: true,
    findings: []
  },
  quarantinedReports: [
    {
      id: "held-22",
      issueNumber: 22,
      title: "Run the repro from a pasted installer command",
      security: {
        safeToExecute: false,
        findings: [
          {
            ruleId: "credential-exfiltration",
            severity: "critical",
            reason: "Issue text asks the agent to reveal or export credentials.",
            matchedText: "show env token"
          }
        ]
      }
    }
  ]
};

export const happyPathStatuses: RunStatus[] = [
  "received",
  "security-review",
  "triaging",
  "environment-building",
  "reproducing",
  "verified",
  "minimizing",
  "fixing",
  "validating",
  "patch-ready",
  "awaiting-approval",
  "approved",
  "pr-created"
];

export const statusLabels: Record<RunStatus, string> = {
  received: "Received",
  "security-review": "Security review",
  rejected: "Rejected",
  triaging: "Triaging",
  "needs-info": "Needs info",
  "environment-building": "Environment",
  "environment-failed": "Environment failed",
  reproducing: "Reproducing",
  "not-reproduced": "Not reproduced",
  flaky: "Flaky",
  verified: "Verified",
  minimizing: "Minimizing",
  fixing: "Fixing",
  validating: "Validating",
  "fix-failed": "Fix failed",
  "patch-ready": "Patch ready",
  "awaiting-approval": "Awaiting approval",
  approved: "Approved",
  "pr-created": "PR created"
};

function event(
  id: string,
  status: RunStatus,
  message: string,
  at: string,
  evidence?: Record<string, unknown>
): DashboardRun["events"][number] {
  return {
    id,
    runId: "run-5",
    status,
    message,
    at,
    ...(evidence ? { evidence } : {})
  };
}
