import type { ReproRun, RunStatus, SecurityScanResult } from "@reprosmith/core";
import type { DemoRunSummary } from "@reprosmith/demo-runner";

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
  generatedAt: string;
  source: "webhook" | "demo";
  sourceLabel: string;
  repoLabel: string;
  issueTitle: string;
  assignee: string;
  runtime: string;
  model: string;
  currentBranch: string;
  candidatePatch?: {
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

interface WebhookRunRecord {
  receivedAt: string;
  deliveryId: string;
  repository: string;
  issueTitle: string;
  issueBody: string;
  run: ReproRun;
  scan: SecurityScanResult;
  trueForge?: {
    status?: string;
    reason?: string;
    error?: string;
    session?: { id?: string; title?: string | null };
    turn?: { id?: string; status?: string };
    result?: {
      status?: string;
      summary?: string;
      proof?: { before?: string; after?: string; regressions?: string; attempts?: string };
      candidatePatch?: {
        title: string;
        body: string;
        baseBranch: string;
        branchName: string;
        files: Array<{ path: string; content: string }>;
        hash: string;
        verifiedAt: string;
      };
    };
  };
}

export function apiUrl(path: string): string {
  const baseUrl = (import.meta.env.VITE_REPROSMITH_API_URL ?? "").trim().replace(/\/+$/, "");
  return `${baseUrl}${path}`;
}

export async function fetchDashboardRun(fetchImpl: typeof fetch = fetch): Promise<DashboardRun> {
  if (import.meta.env.VITE_REPROSMITH_DATA_MODE === "demo") {
    const response = await fetchImpl(apiUrl("/api/demo-run"), { cache: "no-store" });
    if (!response.ok) {
      throw new Error(`Demo run API returned ${response.status}`);
    }

    return toDashboardRun((await response.json()) as DemoRunSummary);
  }

  const liveResponse = await fetchImpl(apiUrl("/api/runs/latest"), { cache: "no-store" });
  if (!liveResponse.ok) {
    if (liveResponse.status === 404) {
      throw new Error("No persisted GitHub webhook run is available yet");
    }

    throw new Error(`Live run API returned ${liveResponse.status}`);
  }

  return toDashboardRunFromWebhook((await liveResponse.json()) as WebhookRunRecord);
}

export function toDashboardRun(summary: DemoRunSummary): DashboardRun {
  const expected = summary.validation.before.expected;
  const matchedAttempts = summary.validation.before.attempts.filter((attempt) => attempt.matchedExpected).length;
  const totalAttempts = summary.validation.before.attempts.length;
  const afterPassed = commandPassed(summary.validation.after);
  const regressionsPassed = summary.validation.regressions ? commandPassed(summary.validation.regressions) : undefined;

  return {
    ...summary.run,
    generatedAt: summary.generatedAt,
    source: "demo",
    sourceLabel: "local proof demo",
    repoLabel: summary.repository.replace("/", " / "),
    issueTitle: summary.issueTitle,
    assignee: "ReproSmith agent",
    runtime: summary.runtime,
    model: summary.model,
    currentBranch: summary.currentBranch,
    candidatePatch: summary.candidatePatch,
    evidence: [
      {
        id: "failure-fingerprint",
        kind: "stack",
        title: "Failure fingerprint",
        value: formatFailure(expected),
        detail: `${matchedAttempts}/${totalAttempts} attempts matched`,
        status: summary.validation.before.status === "verified" ? "verified" : "warning"
      },
      {
        id: "runner-result",
        kind: "stdout",
        title: "Runner result",
        value: `exit ${summary.validation.after.exitCode ?? "not run"} after patch`,
        detail: afterPassed ? "No timeout or output-limit flags" : summary.validation.reason ?? "Patch proof failed",
        status: afterPassed ? "verified" : "blocked"
      },
      {
        id: "patch-files",
        kind: "patch",
        title: "Files changed",
        value: pluralize(summary.validation.filesChanged.length, "file"),
        detail: summary.validation.filesChanged.join(", ") || "No files changed",
        status: summary.validation.status === "patch-ready" ? "verified" : "warning"
      },
      {
        id: "security-scan",
        kind: "policy",
        title: "Security scan",
        value: pluralize(summary.safeIssueScan.findings.length, "finding"),
        detail: summary.safeIssueScan.safeToExecute ? "Run cleared for sandbox execution" : "Run blocked before execution",
        status: summary.safeIssueScan.safeToExecute ? "verified" : "blocked"
      },
      {
        id: "regression-proof",
        kind: "stdout",
        title: "Regression proof",
        value: regressionsPassed === undefined ? "not configured" : regressionsPassed ? "passed" : "failed",
        detail: summary.validation.regressions
          ? `exit ${summary.validation.regressions.exitCode ?? "not run"}`
          : "No regression command returned",
        status: regressionsPassed === false ? "blocked" : "verified"
      }
    ],
    approvals: approvalActions,
    security: summary.safeIssueScan,
    quarantinedReports: summary.quarantinedIssueScan.findings.length
      ? [
          {
            id: "held-demo-input",
            issueNumber: summary.run.issue.issueNumber,
            title: "Quarantined issue instruction",
            security: summary.quarantinedIssueScan
          }
        ]
      : []
  };
}

export function toDashboardRunFromWebhook(record: WebhookRunRecord): DashboardRun {
  const trueForgeStatus = record.trueForge?.status ?? "unknown";
  const liveResult = record.trueForge?.result;
  const livePatch = liveResult?.candidatePatch;
  const trueForgeDetail =
    record.trueForge?.session?.id ??
    liveResult?.summary ??
    record.trueForge?.reason ??
    record.trueForge?.error ??
    "No TrueForge metadata returned";
  const trueForgeBlocked = trueForgeStatus === "failed" || trueForgeStatus === "not-configured" || liveResult?.status === "failed";
  const issueBodySize = new Blob([record.issueBody]).size;

  return {
    ...record.run,
    generatedAt: record.receivedAt,
    source: "webhook",
    sourceLabel: "latest GitHub webhook",
    repoLabel: record.repository.replace("/", " / "),
    issueTitle: record.issueTitle,
    assignee: trueForgeStatus === "started" || liveResult ? "TrueForge agent" : "Server intake",
    runtime: trueForgeStatus === "started" || liveResult ? "TrueForge Agent Harness" : "Webhook intake",
    model: trueForgeStatus === "started" || liveResult ? "Configured by TrueForge" : "Not started",
    currentBranch: livePatch?.branchName ?? `delivery ${record.deliveryId}`,
    ...(livePatch
      ? {
          candidatePatch: {
            title: livePatch.title,
            files: livePatch.files.map((file) => file.path),
            hash: livePatch.hash,
            verifiedAt: livePatch.verifiedAt
          }
        }
      : {}),
    evidence: [
      {
        id: "security-scan",
        kind: "policy",
        title: "Security scan",
        value: pluralize(record.scan.findings.length, "finding"),
        detail: record.scan.safeToExecute ? "Issue cleared for live orchestration" : "Issue blocked before execution",
        status: record.scan.safeToExecute ? "verified" : "blocked"
      },
      {
        id: "trueforge-session",
        kind: "stdout",
        title: "TrueForge handoff",
        value: trueForgeStatus,
        detail: trueForgeDetail,
        status: trueForgeBlocked ? "blocked" : liveResult ? "verified" : trueForgeStatus === "started" ? "verified" : "warning"
      },
      ...(liveResult?.proof
        ? [
            {
              id: "proof-result",
              kind: "stdout" as const,
              title: "Live proof result",
              value: liveResult.status ?? "unknown",
              detail: [liveResult.proof.attempts, liveResult.proof.before, liveResult.proof.after, liveResult.proof.regressions]
                .filter(Boolean)
                .join(" | "),
              status: liveResult.status === "patch-ready" || liveResult.status === "verified" ? ("verified" as const) : ("warning" as const)
            }
          ]
        : []),
      {
        id: "issue-payload",
        kind: "stack",
        title: "Issue payload",
        value: `${issueBodySize} bytes`,
        detail: `received ${formatWebhookTime(record.receivedAt)}`,
        status: "verified"
      }
    ],
    approvals: record.run.status === "awaiting-approval" && livePatch ? approvalActions : [],
    security: record.scan,
    quarantinedReports: record.scan.findings.length
      ? [
          {
            id: `webhook-${record.deliveryId}`,
            issueNumber: record.run.issue.issueNumber,
            title: record.issueTitle,
            security: record.scan
          }
        ]
      : []
  };
}

export const approvalActions: ApprovalAction[] = [
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
];

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
  failed: "Failed",
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

function commandPassed(result: { exitCode: number | null; timedOut: boolean; outputLimitExceeded: boolean }): boolean {
  return result.exitCode === 0 && !result.timedOut && !result.outputLimitExceeded;
}

function formatFailure(failure: { errorType: string; file?: string; line?: number }): string {
  const location = failure.file ? `${shortPath(failure.file)}${failure.line ? `:${failure.line}` : ""}` : undefined;
  return [failure.errorType, location].filter(Boolean).join(" / ");
}

function shortPath(path: string): string {
  return path.replace(/\\/g, "/").split("/").at(-1) ?? path;
}

function pluralize(count: number, noun: string): string {
  return `${count} ${noun}${count === 1 ? "" : "s"}`;
}

function formatWebhookTime(value: string): string {
  return new Intl.DateTimeFormat("en", {
    hour: "2-digit",
    minute: "2-digit",
    hour12: false
  }).format(new Date(value));
}
