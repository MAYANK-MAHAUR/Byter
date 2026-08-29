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

export type HarnessEventCategory = "session" | "agent" | "mcp" | "sandbox" | "subagent" | "github" | "approval";

export interface HarnessTraceEvent {
  id: string;
  sequenceNumber?: number;
  at: string;
  type: string;
  category: HarnessEventCategory;
  source: "trueforge" | "reprosmith";
  status: "info" | "running" | "passed" | "failed";
  summary: string;
  toolName?: string;
  mcpServer?: string;
  target?: string;
  command?: string;
  exitCode?: number | null;
  stdout?: string;
  stderr?: string;
  sandboxId?: string;
  subagent?: string;
  artifact?: string;
}

export interface HarnessState {
  model: string;
  provider: string;
  sessionId?: string;
  turnId?: string;
  status: "running" | "completed" | "paused" | "failed" | "not-configured" | "fixture";
  currentTask: string;
  trace: HarnessTraceEvent[];
  mcpCalls: number;
  sandboxExecutions: number;
  subagents: number;
  dashboardUrl?: string;
  statusCommentUrl?: string;
  commentHistory: Array<{ id?: number; url: string; kind: "started" | "completed" | "failed" | "approval" | "legacy"; createdAt: string }>;
  verifiedLabel?: { name: string; appliedAt?: string; error?: string };
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
    body?: string;
  };
  pullRequest?: { number: number; url: string };
  proof?: { before?: string; after?: string; regressions?: string; attempts?: string };
  harness: HarnessState;
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
  dashboardUrl?: string;
  githubStatusComment?: { id?: number; url: string };
  githubComments?: Array<{ id?: number; url: string; kind: "started" | "completed" | "failed" | "approval"; createdAt: string }>;
  verifiedLabel?: { name: "reprosmith:verified"; appliedAt?: string; error?: string };
  run: ReproRun;
  scan: SecurityScanResult;
  trueForge?: {
    status?: string;
    reason?: string;
    error?: string;
    session?: { id?: string; title?: string | null };
    turn?: { id?: string; status?: string };
    model?: string;
    provider?: string;
    events?: HarnessTraceEvent[];
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
      pullRequest?: { number: number; url: string };
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

  const runId = typeof window !== "undefined" && window.location.pathname.startsWith("/runs/")
    ? window.location.pathname.slice("/runs/".length)
    : undefined;
  const endpoint = runId ? `/api/runs/${encodeURIComponent(decodeURIComponent(runId))}` : "/api/runs/latest";
  const liveResponse = await fetchImpl(apiUrl(endpoint), { cache: "no-store" });
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
    proof: {
      before: `${matchedAttempts}/${totalAttempts} reproduction attempts matched the failure`,
      after: afterPassed ? "Candidate patch passed the reproduction" : "Candidate patch did not pass the reproduction",
      regressions: summary.validation.regressions
        ? `Regression command exited ${summary.validation.regressions.exitCode ?? "without a result"}`
        : "No regression command returned",
      attempts: `${matchedAttempts}/${totalAttempts} attempts`
    },
    harness: buildDemoHarness(summary),
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
  const pullRequest = liveResult?.pullRequest;
  const trueForgeDetail =
    record.trueForge?.session?.id ??
    liveResult?.summary ??
    record.trueForge?.reason ??
    record.trueForge?.error ??
    "No TrueForge metadata returned";
  const trueForgeBlocked = trueForgeStatus === "failed" || trueForgeStatus === "not-configured" || liveResult?.status === "failed";
  const issueBodySize = new Blob([record.issueBody]).size;
  const trace = record.trueForge?.events ?? [];
  const commentHistory = record.githubComments ?? (record.githubStatusComment ? [{ ...record.githubStatusComment, kind: "legacy" as const, createdAt: record.receivedAt }] : []);
  const latestComment = commentHistory.at(-1);

  return {
    ...record.run,
    generatedAt: record.receivedAt,
    source: "webhook",
    sourceLabel: "latest GitHub webhook",
    repoLabel: record.repository.replace("/", " / "),
    issueTitle: record.issueTitle,
    assignee: trueForgeStatus === "started" || liveResult ? "TrueForge agent" : "Server intake",
    runtime: trueForgeStatus === "started" || liveResult ? "TrueForge Agent Harness" : "Webhook intake",
    model: record.trueForge?.model ?? (trueForgeStatus === "started" || liveResult ? "Configured by TrueForge" : "Not started"),
    currentBranch: livePatch?.branchName ?? `delivery ${record.deliveryId}`,
    ...(livePatch
      ? {
          candidatePatch: {
            title: livePatch.title,
            files: livePatch.files.map((file) => file.path),
            hash: livePatch.hash,
            verifiedAt: livePatch.verifiedAt,
            body: livePatch.body
          }
        }
      : {}),
    ...(pullRequest ? { pullRequest } : {}),
    ...(liveResult?.proof ? { proof: compactProof(liveResult.proof) } : {}),
    harness: {
      model: record.trueForge?.model ?? (trueForgeStatus === "started" || liveResult ? "Configured model" : "Not started"),
      provider: record.trueForge?.provider ?? (trueForgeStatus === "started" || liveResult ? "Configured provider" : "Not started"),
      sessionId: record.trueForge?.session?.id,
      turnId: record.trueForge?.turn?.id,
      status: harnessStatusFor(record.run.status, trueForgeStatus, liveResult?.status),
      currentTask: currentTaskFor(record.run.status, liveResult?.summary),
      trace,
      mcpCalls: trace.filter((event) => event.category === "mcp" && event.type !== "mcp.initialize").length,
      sandboxExecutions: trace.filter((event) => event.category === "sandbox" && (event.command || event.sandboxId || event.stdout || event.stderr)).length,
      subagents: trace.filter((event) => event.category === "subagent").length,
      dashboardUrl: record.dashboardUrl,
      statusCommentUrl: latestComment?.url,
      commentHistory,
      verifiedLabel: record.verifiedLabel
    },
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

function harnessStatusFor(
  runStatus: RunStatus,
  trueForgeStatus: string,
  resultStatus: string | undefined
): HarnessState["status"] {
  if (trueForgeStatus === "not-configured") return "not-configured";
  if (trueForgeStatus === "failed" || resultStatus === "failed" || runStatus === "failed") return "failed";
  if (runStatus === "awaiting-approval") return "paused";
  if (trueForgeStatus === "completed" || runStatus === "pr-created") return "completed";
  return "running";
}

function currentTaskFor(runStatus: RunStatus, summary?: string): string {
  if (runStatus === "awaiting-approval") return "Waiting for maintainer approval before GitHub mutation";
  if (runStatus === "pr-created") return "Pull request receipt recorded";
  if (runStatus === "failed" || runStatus === "rejected") return summary ?? "Run stopped before repository mutation";
  if (runStatus === "patch-ready" || runStatus === "validating") return "Validating the candidate patch against the reproduction";
  if (runStatus === "reproducing" || runStatus === "verified") return "Reproducing the issue in the Daytona sandbox";
  if (runStatus === "environment-building") return "Preparing the disposable execution environment";
  return "Triaging the GitHub issue";
}

function compactProof(proof: { before?: string; after?: string; regressions?: string; attempts?: string }) {
  return {
    ...(proof.before ? { before: compactEvidence(proof.before, 360) } : {}),
    ...(proof.after ? { after: compactEvidence(proof.after, 360) } : {}),
    ...(proof.regressions ? { regressions: compactEvidence(proof.regressions, 420) } : {}),
    ...(proof.attempts ? { attempts: compactEvidence(proof.attempts, 160) } : {})
  };
}

function compactEvidence(value: string, maxLength: number): string {
  const compact = value.replace(/\s+/g, " ").trim();
  return compact.length <= maxLength ? compact : `${compact.slice(0, maxLength - 1).trimEnd()}...`;
}

function buildDemoHarness(summary: DemoRunSummary): HarnessState {
  const trace = demoTrace(summary);
  return {
    model: summary.model,
    provider: summary.model.split(" ")[0] ?? "fixture",
    status: "fixture",
    currentTask: "Fixture proof complete; approval is simulated",
    trace,
    mcpCalls: trace.filter((event) => event.category === "mcp").length,
    sandboxExecutions: trace.filter((event) => event.category === "sandbox" && event.command).length,
    subagents: 0,
    commentHistory: []
  };
}

function demoTrace(summary: DemoRunSummary): HarnessTraceEvent[] {
  const at = (offset: number) => new Date(Date.parse(summary.generatedAt) + offset * 1_000).toISOString();
  return [
    {
      id: "demo-issue",
      at: at(0),
      type: "mcp.read_issue",
      category: "mcp",
      source: "reprosmith",
      status: "passed",
      summary: "Fixture read of the GitHub issue",
      toolName: "read_issue",
      mcpServer: "reprosmith-github",
      target: "issue #17"
    },
    {
      id: "demo-file",
      at: at(2),
      type: "mcp.read_file",
      category: "mcp",
      source: "reprosmith",
      status: "passed",
      summary: "Fixture read of parser.mjs",
      toolName: "read_file",
      mcpServer: "reprosmith-github",
      target: "parser.mjs"
    },
    {
      id: "demo-sandbox",
      at: at(4),
      type: "sandbox.created",
      category: "sandbox",
      source: "reprosmith",
      status: "passed",
      summary: "Fixture sandbox created",
      sandboxId: "demo-local-sandbox"
    },
    {
      id: "demo-before",
      at: at(6),
      type: "sandbox.exec",
      category: "sandbox",
      source: "reprosmith",
      status: "passed",
      summary: "Fixture reproduction command completed",
      command: "node repro.mjs",
      exitCode: 1,
      stderr: "TypeError: Cannot read properties of undefined"
    },
    {
      id: "demo-after",
      at: at(8),
      type: "sandbox.exec",
      category: "sandbox",
      source: "reprosmith",
      status: "passed",
      summary: "Fixture regression command completed",
      command: "node regression.mjs",
      exitCode: 0,
      stdout: "passed"
    },
    {
      id: "demo-done",
      at: at(10),
      type: "turn.done",
      category: "session",
      source: "reprosmith",
      status: "passed",
      summary: "Fixture proof complete"
    }
  ];
}

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
