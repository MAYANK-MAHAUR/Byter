import { createHash } from "node:crypto";
import { createReadStream } from "node:fs";
import { appendFile, mkdir, open, readFile, stat } from "node:fs/promises";
import { createServer, type IncomingMessage, type Server, type ServerResponse } from "node:http";
import { dirname, extname, join, resolve } from "node:path";
import { fileURLToPath } from "node:url";
import { ReproSmithTrueForgeRuntime } from "@reprosmith/agent";
import {
  approvalPayloadHash,
  createGitHubMcpHttpHandler,
  createGitHubMcpTools,
  type GitHubMcpToolResult,
  type GitHubRestClientLike
} from "@reprosmith/github-mcp";
import type {
  StartReproSmithSessionInput,
  StartReproSmithSessionResult,
  TrueForgeRuntimeEventListener,
  TrueForgeRuntimeEvent
} from "@reprosmith/agent";
import { canTransition, createRun, scanIssueText, transitionRun } from "@reprosmith/core";
import { runDemo, type DemoRunSummary } from "@reprosmith/demo-runner";
import { GitHubRestClient, parseIssueWebhook, verifyGitHubWebhook } from "@reprosmith/github";

type ApprovalActionId = "approve-pr" | "request-diff" | "reject-run";
type GitHubCommentKind = "started" | "completed" | "failed" | "approval";
const maxRequestBodyBytes = 64 * 1024;
const maxLatestRunReadBytes = 256 * 1024;
const maxResultTextBytes = 256 * 1024;
const maxPatchFiles = 40;
const maxPatchFileBytes = 512 * 1024;
const maxPatchTotalBytes = 2 * 1024 * 1024;
const maxHarnessEvents = 120;
const maxHarnessTextBytes = 4 * 1024;
const demoCacheTtlMs = 5_000;
let demoCache: { createdAt: number; summary: DemoRunSummary } | undefined;
let demoInFlight: Promise<DemoRunSummary> | undefined;

export interface ReproSmithServerOptions {
  staticDir?: string;
  dataDir?: string;
  trueForgeRuntime?: ReproSmithSessionStarter;
  mcpHandler?: McpRequestHandler;
  githubTools?: GitHubWriteTools;
  githubClient?: GitHubRestClientLike;
}

type McpRequestHandler = (request: IncomingMessage, response: ServerResponse) => Promise<void>;

interface GitHubWriteTools {
  callTool(call: {
    name: "create_fix_pull_request";
    arguments: Record<string, unknown>;
    approval: { approved: boolean; expectedPayloadHash: string };
  }): Promise<GitHubMcpToolResult>;
}

interface LiveCandidatePatch {
  title: string;
  body: string;
  baseBranch: string;
  branchName: string;
  files: Array<{ path: string; content: string }>;
  hash: string;
  verifiedAt: string;
}

interface LiveProofResult {
  status: "patch-ready" | "verified" | "not-reproduced" | "blocked" | "failed";
  summary: string;
  proof?: {
    before?: string;
    after?: string;
    regressions?: string;
    attempts?: string;
  };
  candidatePatch?: LiveCandidatePatch;
  pullRequest?: { number: number; url: string };
}

type HarnessEventCategory = "session" | "agent" | "mcp" | "sandbox" | "subagent" | "github" | "approval";

interface HarnessTraceEvent {
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

interface ReproSmithSessionStarter {
  startSession(input: StartReproSmithSessionInput): Promise<StartReproSmithSessionResult>;
  subscribeToTurn?(sessionId: string, turnId: string, onEvent?: TrueForgeRuntimeEventListener): Promise<TrueForgeRuntimeEvent[]>;
  listSessionEvents?(sessionId: string): Promise<TrueForgeRuntimeEvent[]>;
}

interface PersistedWebhookRunRecord {
  receivedAt: string;
  deliveryId: string;
  repository: string;
  baseBranch: string;
  issueTitle: string;
  issueBody: string;
  dashboardUrl?: string;
  githubStatusComment?: { id?: number; url: string };
  githubComments?: Array<{ id?: number; url: string; kind: GitHubCommentKind; createdAt: string }>;
  verifiedLabel?: { name: "reprosmith:verified"; appliedAt?: string; error?: string };
  run: ReturnType<typeof createRun>;
  scan: ReturnType<typeof scanIssueText>;
  trueForge: {
    status: string;
    reason?: string;
    error?: string;
    session?: { id: string; title: string | null };
    turn?: { id: string; status: string };
    model?: string;
    provider?: string;
    events?: HarnessTraceEvent[];
    result?: LiveProofResult;
  };
}

export function createReproSmithServer(options: ReproSmithServerOptions = {}): Server {
  const staticDir = resolve(options.staticDir ?? process.env.STATIC_DIR ?? defaultStaticDir());
  const dataDir = options.dataDir ?? process.env.DATA_DIR;
  const trueForgeRuntime = options.trueForgeRuntime ?? trueForgeRuntimeFromEnv();
  const githubClient = options.githubClient ?? githubClientFromEnv();
  const githubTools = options.githubTools ?? (githubClient ? createGitHubMcpTools({ client: githubClient }) : undefined);
  const mcpHandler = options.mcpHandler ?? githubMcpHandlerFromEnv(githubClient);

  return createServer(async (request, response) => {
    const url = new URL(request.url ?? "/", "http://localhost");

    try {
      if (url.pathname === "/healthz") {
        sendJson(response, 200, { ok: true });
        return;
      }

      if (url.pathname === "/api/demo-run") {
        await handleDemoRun(request, response);
        return;
      }

      if (url.pathname === "/api/runs/latest") {
        await handleLatestRun(request, response, dataDir ? resolve(dataDir) : undefined, trueForgeRuntime);
        return;
      }

      if (url.pathname.startsWith("/api/runs/") && url.pathname !== "/api/runs/latest") {
        await handleRun(request, response, dataDir ? resolve(dataDir) : undefined, decodeRunId(url.pathname), trueForgeRuntime);
        return;
      }

      if (url.pathname === "/mcp") {
        if (!mcpHandler) {
          sendJson(response, 503, { error: "MCP endpoint is not configured" });
          return;
        }
        await mcpHandler(request, response);
        return;
      }

      if (url.pathname === "/api/approvals") {
        await handleApproval(request, response, dataDir ? resolve(dataDir) : undefined, githubTools, githubClient);
        return;
      }

      if (url.pathname === "/api/github/webhook") {
        await handleGitHubWebhook(
          request,
          response,
          dataDir ? resolve(dataDir) : undefined,
          trueForgeRuntime,
          githubClient
        );
        return;
      }

      await serveStatic(url.pathname, response, staticDir);
    } catch (error) {
      if (error instanceof HttpError) {
        sendJson(response, error.statusCode, { error: error.publicMessage });
        return;
      }

      console.error(error);
      sendJson(response, 500, { error: "Server error" });
    }
  });
}

async function handleGitHubWebhook(
  request: IncomingMessage,
  response: ServerResponse,
  dataDir: string | undefined,
  trueForgeRuntime: ReproSmithSessionStarter | undefined,
  githubClient: GitHubRestClientLike | undefined
): Promise<void> {
  if (request.method !== "POST") {
    sendJson(response, 405, { error: "Method not allowed" });
    return;
  }

  const secret = process.env.GITHUB_WEBHOOK_SECRET;
  if (!secret) {
    sendJson(response, 503, { error: "GITHUB_WEBHOOK_SECRET is not configured" });
    return;
  }

  if (!dataDir) {
    sendJson(response, 503, { error: "DATA_DIR is required for webhook deduplication" });
    return;
  }

  const payload = await readText(request);
  const signatureHeader = headerValue(request, "x-hub-signature-256");
  if (!verifyGitHubWebhook({ payload, signatureHeader, secret })) {
    sendJson(response, 403, { error: "Invalid GitHub webhook signature" });
    return;
  }

  const deliveryId = headerValue(request, "x-github-delivery");
  if (!deliveryId) {
    sendJson(response, 400, { error: "X-GitHub-Delivery is required" });
    return;
  }

  if (dataDir && (await deliveryWasProcessed(dataDir, deliveryId))) {
    sendJson(response, 202, { ignored: true, reason: "Duplicate GitHub delivery" });
    return;
  }

  const eventName = headerValue(request, "x-github-event");
  if (eventName && eventName !== "issues") {
    sendJson(response, 202, { ignored: true, reason: `Unsupported GitHub event: ${eventName}` });
    return;
  }

  let webhook: ReturnType<typeof parseIssueWebhook>;
  try {
    webhook = parseIssueWebhook(payload);
  } catch {
    throw new HttpError(400, "Malformed GitHub issues webhook payload");
  }
  if (!["opened", "edited", "reopened", "labeled"].includes(webhook.action)) {
    sendJson(response, 202, { ignored: true, reason: `Unsupported issue action: ${webhook.action}` });
    return;
  }

  const explicitTrigger = hasExplicitTrigger(webhook);
  if (
    (webhook.action === "labeled" && !hasTriggerLabel(webhook)) ||
    ((webhook.action === "edited" || webhook.action === "reopened") && !explicitTrigger) ||
    (requiresExplicitTrigger() && !explicitTrigger)
  ) {
    sendJson(response, 202, {
      ignored: true,
      reason: `Issue does not have the ${triggerLabel()} label or an explicit trigger marker`
    });
    return;
  }

  const issueText = [webhook.issue.title, webhook.issue.body ?? ""].join("\n");
  const scan = scanIssueText(issueText);
  const runId = `github-${webhook.repository.owner.login}-${webhook.repository.name}-${webhook.issue.number}-${createHash("sha256")
    .update(deliveryId)
    .digest("hex")
    .slice(0, 12)}`;
  let run = createRun(runId, {
    owner: webhook.repository.owner.login,
    repo: webhook.repository.name,
    issueNumber: webhook.issue.number,
    url: webhook.issue.html_url
  });
  run = transitionRun(run, "security-review", "GitHub issue webhook verified and scanned", {
    evidence: { action: webhook.action, safeToExecute: scan.safeToExecute, findings: scan.findings.length }
  });
  run = transitionRun(
    run,
    scan.safeToExecute ? "triaging" : "rejected",
    scan.safeToExecute ? "Issue ready for TrueForge triage" : "Issue rejected by security policy"
  );
  const orchestration = await startTrueForgeSessionForIssue(run, webhook, scan.safeToExecute, trueForgeRuntime);
  run = orchestration.run;

  const record: PersistedWebhookRunRecord = {
    receivedAt: new Date().toISOString(),
    deliveryId,
    repository: webhook.repository.full_name,
    baseBranch: webhook.repository.default_branch,
    issueTitle: webhook.issue.title,
    issueBody: webhook.issue.body ?? "",
    dashboardUrl: dashboardUrlFor(run.id),
    run,
    scan,
    trueForge: orchestration.trueForge
  };
  await mkdir(dataDir, { recursive: true });
  const commentRecord = await appendGitHubComment(record, githubClient, "started");
  await appendFile(join(dataDir, "webhook-runs.jsonl"), `${JSON.stringify(commentRecord)}\n`, "utf8");
  if (orchestration.trueForge.status === "started" && trueForgeRuntime?.subscribeToTurn) {
    void monitorTrueForgeTurn(dataDir, commentRecord, trueForgeRuntime, githubClient);
  }

  sendJson(response, 202, commentRecord);
}

async function handleLatestRun(
  request: IncomingMessage,
  response: ServerResponse,
  dataDir: string | undefined,
  trueForgeRuntime: ReproSmithSessionStarter | undefined
): Promise<void> {
  if (request.method !== "GET") {
    sendJson(response, 405, { error: "Method not allowed" });
    return;
  }

  if (!dataDir) {
    sendJson(response, 404, { error: "No persisted webhook runs are configured" });
    return;
  }

  const latest = await readLatestJsonlRecord(dataDir, "webhook-runs.jsonl");
  if (!latest) {
    sendJson(response, 404, { error: "No persisted webhook runs found" });
    return;
  }

  const refreshed = await refreshLegacyHarnessTrace(dataDir, latest, trueForgeRuntime);
  sendJson(response, 200, hydratePersistedPullRequest(ensureDashboardUrl(refreshed)));
}

async function handleRun(
  request: IncomingMessage,
  response: ServerResponse,
  dataDir: string | undefined,
  runId: string,
  trueForgeRuntime: ReproSmithSessionStarter | undefined
): Promise<void> {
  if (request.method !== "GET") {
    sendJson(response, 405, { error: "Method not allowed" });
    return;
  }

  const record = await findPersistedRunById(dataDir, runId);
  if (!record) {
    sendJson(response, 404, { error: "Persisted run not found" });
    return;
  }

  const refreshed = await refreshLegacyHarnessTrace(dataDir, record, trueForgeRuntime);
  sendJson(response, 200, hydratePersistedPullRequest(ensureDashboardUrl(refreshed)));
}

function ensureDashboardUrl(value: unknown): unknown {
  if (!isRecord(value) || !isRecord(value.run) || typeof value.run.id !== "string") {
    return value;
  }
  if (typeof value.dashboardUrl === "string" && value.dashboardUrl.length > 0) {
    return value;
  }
  return { ...value, dashboardUrl: dashboardUrlFor(value.run.id) };
}

function decodeRunId(pathname: string): string {
  const value = pathname.slice("/api/runs/".length);
  try {
    return decodeURIComponent(value);
  } catch {
    throw new HttpError(400, "Invalid run id");
  }
}

async function refreshLegacyHarnessTrace(
  dataDir: string | undefined,
  value: unknown,
  trueForgeRuntime: ReproSmithSessionStarter | undefined
): Promise<unknown> {
  if (!dataDir || !trueForgeRuntime?.listSessionEvents || !isRecord(value) || !isRecord(value.trueForge)) {
    return value;
  }

  const session = isRecord(value.trueForge.session) && typeof value.trueForge.session.id === "string"
    ? value.trueForge.session.id
    : undefined;
  const currentEvents = Array.isArray(value.trueForge.events) ? value.trueForge.events : [];
  const hasRichTrace = currentEvents.some((event) => isRecord(event) && typeof event.category === "string");
  const needsMetadata = typeof value.trueForge.model !== "string" || typeof value.trueForge.provider !== "string";
  if (!session || (!needsMetadata && hasRichTrace)) {
    return value;
  }

  try {
    const events = hasRichTrace ? [] : await trueForgeRuntime.listSessionEvents(session);
    const projected = hasRichTrace ? [] : events.flatMap((event, index) => projectTrueForgeEvent(event, index));
    if (!hasRichTrace && projected.length === 0 && !needsMetadata) return value;
    const updated = {
      ...value,
      trueForge: {
        ...value.trueForge,
        ...(typeof value.trueForge.model === "string"
          ? {}
          : { model: process.env.MODEL_NAME ?? "TrueForge configured model" }),
        ...(typeof value.trueForge.provider === "string"
          ? {}
          : { provider: process.env.MODEL_PROVIDER ?? "agentrouter" }),
        ...(hasRichTrace ? {} : { events: mergeHarnessEvents([], projected) })
      }
    } as PersistedWebhookRunRecord;
    await appendUpdatedLiveRecord(dataDir, updated);
    return updated;
  } catch (error) {
    console.error("Legacy TrueForge trace refresh failed", error);
    return value;
  }
}

function hydratePersistedPullRequest(value: unknown): unknown {
  if (!isRecord(value) || !isRecord(value.run) || value.run.status !== "pr-created" || !isRecord(value.trueForge)) {
    return value;
  }

  const result = isRecord(value.trueForge.result) ? value.trueForge.result : {};
  if (isPullRequest(result.pullRequest)) {
    return value;
  }

  const events = Array.isArray(value.run.events) ? value.run.events : [];
  const eventEvidence = [...events]
    .reverse()
    .map((event) => (isRecord(event) && isRecord(event.evidence) ? event.evidence : undefined))
    .find((evidence) => isPullRequestEvidence(evidence));
  const fromEvent = eventEvidence && isPullRequestEvidence(eventEvidence)
    ? { number: eventEvidence.pullRequestNumber, url: eventEvidence.pullRequestUrl }
    : undefined;
  const summary = typeof result.summary === "string" ? result.summary : "";
  const fromSummary = summary.match(/Draft PR created:\s+(https:\/\/github\.com\/[^\s]+)/)?.[1];
  const pullRequest = fromEvent ?? (fromSummary ? { number: Number(fromSummary.match(/\/pull\/(\d+)(?:\?|$)/)?.[1]), url: fromSummary } : undefined);

  if (!isPullRequest(pullRequest)) {
    return value;
  }

  return {
    ...value,
    trueForge: {
      ...value.trueForge,
      result: { ...result, pullRequest }
    }
  };
}

function isPullRequestEvidence(value: Record<string, unknown> | undefined): value is Record<string, unknown> & {
  pullRequestNumber: number;
  pullRequestUrl: string;
} {
  return value !== undefined && typeof value.pullRequestNumber === "number" && typeof value.pullRequestUrl === "string";
}

function isPullRequest(value: unknown): value is { number: number; url: string } {
  return isRecord(value) && typeof value.number === "number" && Number.isInteger(value.number) && value.number > 0 && typeof value.url === "string";
}

async function startTrueForgeSessionForIssue(
  run: ReturnType<typeof createRun>,
  webhook: ReturnType<typeof parseIssueWebhook>,
  safeToExecute: boolean,
  trueForgeRuntime: ReproSmithSessionStarter | undefined
) {
  if (!safeToExecute) {
    return {
      run,
      trueForge: {
        status: "skipped",
        reason: "Issue was rejected by security policy"
      }
    };
  }

  if (!trueForgeRuntime) {
    return {
      run,
      trueForge: {
        status: "not-configured",
        reason: "TRUEFORGE_URL and TRUEFORGE_API_KEY are required before live orchestration can start"
      }
    };
  }

  try {
    const result = await trueForgeRuntime.startSession({
      repository: webhook.repository.full_name,
      issueUrl: webhook.issue.html_url,
      issueTitle: webhook.issue.title,
      issueBody: webhook.issue.body ?? ""
    });

    return {
      run: transitionRun(run, "environment-building", "TrueForge session started", {
        evidence: {
          sessionId: result.session.id,
          turnId: result.turn.id,
          turnStatus: result.turn.status
        }
      }),
      trueForge: {
        status: "started",
        session: result.session,
        turn: result.turn,
        model: process.env.MODEL_NAME ?? "configured model",
        provider: process.env.MODEL_PROVIDER ?? "configured provider"
      }
    };
  } catch (error) {
    return {
      run: transitionRun(run, "failed", "TrueForge session start failed", {
        evidence: {
          error: error instanceof Error ? error.message : "Unknown TrueForge error"
        }
      }),
      trueForge: {
        status: "failed",
        error: error instanceof Error ? error.message : "Unknown TrueForge error"
      }
    };
  }
}

async function handleDemoRun(request: IncomingMessage, response: ServerResponse): Promise<void> {
  if (request.method !== "GET") {
    sendJson(response, 405, { error: "Method not allowed" });
    return;
  }

  sendJson(response, 200, await getDemoRun());
}

async function handleApproval(
  request: IncomingMessage,
  response: ServerResponse,
  dataDir: string | undefined,
  githubTools: GitHubWriteTools | undefined,
  githubClient: GitHubRestClientLike | undefined
): Promise<void> {
  if (request.method !== "POST") {
    sendJson(response, 405, { error: "Method not allowed" });
    return;
  }

  const approvalToken = process.env.APPROVAL_TOKEN;
  if (!approvalToken) {
    sendJson(response, 503, { error: "APPROVAL_TOKEN is not configured" });
    return;
  }

  if (bearerToken(request) !== approvalToken) {
    sendJson(response, 401, { error: "Approval authentication required" });
    return;
  }

  if (!dataDir) {
    sendJson(response, 503, { error: "DATA_DIR is required for approval persistence" });
    return;
  }

  const payload = await readJson(request);
  const actionId = expectApprovalAction(payload.actionId);
  const runId = expectString(payload.runId, "runId");
  const patchHash = expectString(payload.patchHash, "patchHash");
  const liveRecord = await findPersistedRunById(dataDir, runId);
  if (!liveRecord) {
    const latestRun = await getDemoRun();
    if (latestRun.run.id !== runId || latestRun.candidatePatch.hash !== patchHash) {
      sendJson(response, 409, { error: "Approval payload does not match the current run" });
      return;
    }

    const receipt = buildApprovalReceipt(runId, actionId, patchHash, resultStatusFor(actionId), messageFor(actionId));
    await appendApprovalReceipt(dataDir, receipt);
    sendJson(response, 200, receipt);
    return;
  }

  const candidatePatch = liveRecord.trueForge.result?.candidatePatch;
  if (!candidatePatch || candidatePatch.hash !== patchHash) {
    sendJson(response, 409, { error: "Approval payload does not match the live candidate patch" });
    return;
  }
  const previousReceipt = await findApprovalReceipt(dataDir, runId, actionId, patchHash);
  if (previousReceipt?.resultStatus === "writing") {
    sendJson(response, 409, { error: "This approval is already being processed" });
    return;
  }
  if (previousReceipt && previousReceipt.resultStatus !== "write-failed") {
    sendJson(response, 200, previousReceipt);
    return;
  }
  if (liveRecord.run.status !== "awaiting-approval") {
    sendJson(response, 409, { error: "Live run is not awaiting approval" });
    return;
  }

  if (actionId !== "approve-pr") {
    let run = liveRecord.run;
    if (actionId === "reject-run" && canTransition(run.status, "rejected")) {
      run = transitionRun(run, "rejected", "Maintainer rejected the live candidate patch");
    }
    const receipt = buildApprovalReceipt(runId, actionId, patchHash, resultStatusFor(actionId), messageFor(actionId));
    await appendApprovalReceipt(dataDir, receipt);
    const updatedRecord = await appendGitHubComment({
      ...liveRecord,
      run,
      trueForge: {
        ...liveRecord.trueForge,
        events: mergeHarnessEvents(liveRecord.trueForge.events ?? [], [{
          id: `approval:${runId}:${actionId}`,
          at: receipt.savedAt,
          type: "approval.received",
          category: "approval",
          source: "reprosmith",
          status: actionId === "reject-run" ? "failed" : "passed",
          summary: actionId === "reject-run" ? "Maintainer rejected the candidate patch" : "Maintainer requested a diff review",
          artifact: actionId === "reject-run" ? "run stopped" : "write held"
        }])
      }
    }, githubClient, "approval");
    await appendUpdatedLiveRecord(dataDir, updatedRecord);
    sendJson(response, 200, receipt);
    return;
  }

  if (!githubTools) {
    sendJson(response, 503, { error: "GitHub write tools are not configured" });
    return;
  }

  const writeArguments = {
    owner: liveRecord.run.issue.owner,
    repo: liveRecord.run.issue.repo,
    baseBranch: candidatePatch.baseBranch,
    branchName: candidatePatch.branchName,
    title: candidatePatch.title,
    body: candidatePatch.body,
    files: candidatePatch.files
  };
  const expectedPayloadHash = approvalPayloadHash("create_fix_pull_request", writeArguments);
  if (expectedPayloadHash !== candidatePatch.hash) {
    sendJson(response, 409, { error: "Live candidate patch hash is invalid" });
    return;
  }

  const writingReceipt = buildApprovalReceipt(
    runId,
    actionId,
    patchHash,
    "writing",
    "Approval accepted; creating a draft GitHub pull request"
  );
  await appendApprovalReceipt(dataDir, writingReceipt);

  let toolResult: GitHubMcpToolResult;
  try {
    toolResult = await githubTools.callTool({
      name: "create_fix_pull_request",
      arguments: writeArguments,
      approval: { approved: true, expectedPayloadHash }
    });
  } catch (error) {
    const failedReceipt = buildApprovalReceipt(
      runId,
      actionId,
      patchHash,
      "write-failed",
      error instanceof Error ? error.message : "GitHub pull request creation failed"
    );
    await appendApprovalReceipt(dataDir, failedReceipt);
    sendJson(response, 502, { error: failedReceipt.message });
    return;
  }

  const pullRequest = parsePullRequestToolResult(toolResult);
  let run = liveRecord.run;
  if (canTransition(run.status, "approved")) {
    run = transitionRun(run, "approved", "Maintainer approved the verified candidate patch");
  }
  if (canTransition(run.status, "pr-created")) {
    run = transitionRun(run, "pr-created", "Draft GitHub pull request created", {
      evidence: { pullRequestUrl: pullRequest.url, pullRequestNumber: pullRequest.number }
    });
  }
  const updatedRecord: PersistedWebhookRunRecord = {
    ...liveRecord,
    run,
    trueForge: {
      ...liveRecord.trueForge,
      events: mergeHarnessEvents(liveRecord.trueForge.events ?? [], [
        {
          id: `approval:${runId}:${actionId}`,
          at: new Date().toISOString(),
          type: "approval.received",
          category: "approval",
          source: "reprosmith",
          status: "passed",
          summary: "Maintainer approval received; GitHub write completed",
          toolName: "create_fix_pull_request",
          target: `${liveRecord.run.issue.owner}/${liveRecord.run.issue.repo}`,
          artifact: `draft PR #${pullRequest.number}`
        }
      ]),
      result: {
        ...liveRecord.trueForge.result!,
        summary: `${liveRecord.trueForge.result?.summary ?? "Verified candidate patch"} Draft PR created: ${pullRequest.url}`,
        pullRequest
      }
    }
  };
  const commentedRecord = await appendGitHubComment(updatedRecord, githubClient, "approval");
  await appendUpdatedLiveRecord(dataDir, commentedRecord);
  const receipt = buildApprovalReceipt(
    runId,
    actionId,
    patchHash,
    "pr-created",
    "Draft GitHub pull request created",
    { pullRequest }
  );
  await appendApprovalReceipt(dataDir, receipt);
  sendJson(response, 200, receipt);
}

interface ApprovalReceipt {
  id: string;
  runId: string;
  actionId: ApprovalActionId;
  actor: string;
  approvedPayloadHash: string;
  patchHash: string;
  resultStatus: string;
  message: string;
  savedAt: string;
  pullRequest?: { number: number; url: string };
}

function buildApprovalReceipt(
  runId: string,
  actionId: ApprovalActionId,
  patchHash: string,
  resultStatus: string,
  message: string,
  extra: Pick<ApprovalReceipt, "pullRequest"> = {}
): ApprovalReceipt {
  const savedAt = new Date().toISOString();
  return {
    id: createHash("sha256").update(`${runId}:${actionId}:${patchHash}:${resultStatus}:${savedAt}`).digest("hex").slice(0, 16),
    runId,
    actionId,
    actor: "token-authenticated maintainer",
    approvedPayloadHash: createHash("sha256").update(`${runId}:${actionId}:${patchHash}`).digest("hex"),
    patchHash,
    resultStatus,
    message,
    savedAt,
    ...extra
  };
}

async function appendApprovalReceipt(dataDir: string, receipt: ApprovalReceipt): Promise<void> {
  await mkdir(dataDir, { recursive: true });
  await appendFile(join(dataDir, "approvals.jsonl"), `${JSON.stringify(receipt)}\n`, "utf8");
}

async function appendUpdatedLiveRecord(dataDir: string, record: PersistedWebhookRunRecord): Promise<void> {
  await mkdir(dataDir, { recursive: true });
  await appendFile(join(dataDir, "webhook-runs.jsonl"), `${JSON.stringify(record)}\n`, "utf8");
}

async function applyVerifiedLabel(
  record: PersistedWebhookRunRecord,
  githubClient: GitHubRestClientLike | undefined
): Promise<PersistedWebhookRunRecord> {
  if (!githubClient || record.verifiedLabel || !hasGenuineProof(record.trueForge.result)) {
    return record;
  }

  try {
    const owner = record.run.issue.owner;
    const repo = record.run.issue.repo;
    const issueNumber = record.run.issue.issueNumber;
    try {
      await githubClient.addLabels(owner, repo, issueNumber, ["reprosmith:verified"]);
    } catch (error) {
      if (!githubClient.createLabel) throw error;
      await githubClient.createLabel(owner, repo, "reprosmith:verified", "111111", "Issue verified by reproducible evidence");
      await githubClient.addLabels(owner, repo, issueNumber, ["reprosmith:verified"]);
    }
    return {
      ...record,
      verifiedLabel: { name: "reprosmith:verified", appliedAt: new Date().toISOString() }
    };
  } catch {
    return {
      ...record,
      verifiedLabel: { name: "reprosmith:verified", error: "GitHub did not accept the verified label request" }
    };
  }
}

function hasGenuineProof(result: LiveProofResult | undefined): boolean {
  const proof = result?.proof;
  return Boolean(
    (result?.status === "verified" || result?.status === "patch-ready") &&
      proof?.before &&
      proof.after &&
      proof.regressions &&
      proof.attempts
  );
}

async function appendGitHubComment(
  record: PersistedWebhookRunRecord,
  githubClient: GitHubRestClientLike | undefined,
  kind: GitHubCommentKind
): Promise<PersistedWebhookRunRecord> {
  if (!githubClient) {
    return record;
  }

  const body = buildGitHubStatusComment(record, kind);
  try {
    const created = await githubClient.createIssueComment(
      record.run.issue.owner,
      record.run.issue.repo,
      record.run.issue.issueNumber,
      body
    );
    const comment = {
      ...(created.id !== undefined ? { id: created.id } : {}),
      url: created.html_url,
      kind,
      createdAt: new Date().toISOString()
    };
    return {
      ...record,
      githubComments: [...(record.githubComments ?? []), comment],
      githubStatusComment: {
        ...(created.id !== undefined ? { id: created.id } : {}),
        url: created.html_url
      }
    };
  } catch (error) {
    console.error("GitHub progress comment creation failed", error);
    return record;
  }
}

function buildGitHubStatusComment(record: PersistedWebhookRunRecord, kind: GitHubCommentKind): string {
  const status = githubCommentStatus(record);
  const result = record.trueForge.result;
  const proof = result?.summary ? safeCommentText(result.summary, 1_000) : undefined;
  const pullRequest = result?.pullRequest;
  const comments = record.githubComments ?? [];
  const lines = [
    `<!-- reprosmith-run:${record.run.id} -->`,
    `## ReproSmith: ${status.label}`,
    "",
    `**Issue:** #${record.run.issue.issueNumber} ${safeCommentText(record.issueTitle, 300)}`,
    `**Run:** \`${record.run.id}\``,
    `**Dashboard:** [Open the permanent run dashboard](${record.dashboardUrl ?? "#"})`,
    `**TrueForge:** ${record.trueForge.session?.id ? `session \`${record.trueForge.session.id}\`` : "session pending"}${record.trueForge.turn?.id ? `, turn \`${record.trueForge.turn.id}\`` : ""}`,
    `**Update:** ${commentUpdateLabel(kind)}${comments.length > 0 ? ` (update ${comments.length + 1})` : ""}`,
    "",
    safeCommentText(status.detail, 1_000)
  ];

  if (proof) {
    lines.push("", `**Agent summary:** ${proof}`);
  }
  if (result?.proof) {
    lines.push(
      "",
      "### Evidence",
      ...[
        result.proof.attempts ? `- Attempts: ${safeCommentText(result.proof.attempts, 200)}` : undefined,
        result.proof.before ? `- Before: ${safeCommentText(result.proof.before, 900)}` : undefined,
        result.proof.after ? `- After: ${safeCommentText(result.proof.after, 900)}` : undefined,
        result.proof.regressions ? `- Regression: ${safeCommentText(result.proof.regressions, 900)}` : undefined
      ].filter((line): line is string => line !== undefined)
    );
  }
  if (result?.candidatePatch) {
    lines.push(
      "",
      "### Remedy",
      safeCommentText(result.candidatePatch.body, 2_500),
      "",
      `Files: ${result.candidatePatch.files.map((file) => `\`${safeCommentText(file.path, 240)}\``).join(", ")}`,
      `Verified label: ${record.verifiedLabel?.appliedAt ? "`reprosmith:verified` added" : record.verifiedLabel?.error ? "could not be added" : "pending"}`
    );
  } else if (record.run.status === "failed") {
    lines.push(
      "",
      "### Next step",
      "No genuine proof contract was returned. No verified label or repository mutation was made."
    );
  }
  if (pullRequest) {
    lines.push("", `**Draft PR:** [#${pullRequest.number}](${pullRequest.url})`);
  }

  return lines.join("\n");
}

function safeCommentText(value: string, maxBytes: number): string {
  return clampText(redactHarnessText(value), maxBytes);
}

function commentUpdateLabel(kind: GitHubCommentKind): string {
  if (kind === "started") return "TrueForge handoff started";
  if (kind === "completed") return "Proof processing completed";
  if (kind === "failed") return "Run stopped";
  return "Maintainer decision recorded";
}

function githubCommentStatus(record: PersistedWebhookRunRecord): { label: string; detail: string } {
  if (record.run.status === "pr-created") {
    return { label: "Draft PR created", detail: "The approved candidate patch was written as a draft pull request." };
  }
  if (record.run.status === "awaiting-approval") {
    return { label: "Awaiting maintainer approval", detail: "Proof is complete. No branch or pull request has been created." };
  }
  if (record.run.status === "rejected") {
    return { label: "Run rejected", detail: "The run was stopped before repository mutation." };
  }
  if (record.run.status === "failed") {
    return { label: "Run failed", detail: record.trueForge.error ?? "TrueForge did not complete successfully." };
  }
  if (record.trueForge.status === "started") {
    return { label: "Investigation in progress", detail: "TrueForge is inspecting the issue and collecting executable evidence." };
  }
  return { label: "Investigation queued", detail: "ReproSmith accepted the signed issue and is preparing the investigation." };
}

async function findPersistedRunById(dataDir: string | undefined, runId: string): Promise<PersistedWebhookRunRecord | undefined> {
  if (!dataDir) return undefined;
  try {
    const contents = await readFile(join(dataDir, "webhook-runs.jsonl"), "utf8");
    let match: PersistedWebhookRunRecord | undefined;
    for (const line of contents.split("\n").filter(Boolean)) {
      try {
        const record = JSON.parse(line) as PersistedWebhookRunRecord;
        if (record.run?.id === runId) match = record;
      } catch {
        // Ignore a partial or malformed line.
      }
    }
    return match;
  } catch {
    return undefined;
  }
}

async function findApprovalReceipt(
  dataDir: string,
  runId: string,
  actionId: ApprovalActionId,
  patchHash: string
): Promise<ApprovalReceipt | undefined> {
  try {
    const contents = await readFile(join(dataDir, "approvals.jsonl"), "utf8");
    let match: ApprovalReceipt | undefined;
    for (const line of contents.split("\n").filter(Boolean)) {
      try {
        const receipt = JSON.parse(line) as ApprovalReceipt;
        if (receipt.runId === runId && receipt.actionId === actionId && receipt.patchHash === patchHash) {
          match = receipt;
        }
      } catch {
        // Ignore a partial or malformed line.
      }
    }
    return match;
  } catch {
    return undefined;
  }
}

function parsePullRequestToolResult(result: GitHubMcpToolResult): { number: number; url: string } {
  const text = result.content.find((item) => item.type === "text")?.text;
  if (!text) throw new Error("GitHub PR tool returned no result");
  let parsed: unknown;
  try {
    parsed = JSON.parse(text) as unknown;
  } catch {
    throw new Error("GitHub PR tool returned an invalid result");
  }
  if (!isRecord(parsed) || typeof parsed.number !== "number" || typeof parsed.url !== "string") {
    throw new Error("GitHub PR tool result did not include a pull request");
  }
  return { number: parsed.number, url: parsed.url };
}

async function serveStatic(pathname: string, response: ServerResponse, staticDir: string): Promise<void> {
  const requestedPath = pathname === "/" ? "index.html" : pathname.replace(/^\/+/, "");
  const target = resolve(staticDir, requestedPath);
  if (!isInside(staticDir, target)) {
    sendJson(response, 403, { error: "Forbidden" });
    return;
  }

  try {
    const metadata = await stat(target);
    if (!metadata.isFile()) {
      throw new Error("Not a file");
    }
    response.statusCode = 200;
    response.setHeader("Content-Type", contentTypeFor(target));
    createReadStream(target).pipe(response);
  } catch {
    const fallback = join(staticDir, "index.html");
    response.statusCode = 200;
    response.setHeader("Content-Type", "text/html; charset=utf-8");
    response.end(await readFile(fallback, "utf8"));
  }
}

async function readJson(request: IncomingMessage): Promise<Record<string, unknown>> {
  const raw = await readText(request);
  let parsed: unknown;
  try {
    parsed = JSON.parse(raw) as unknown;
  } catch {
    throw new HttpError(400, "Malformed JSON payload");
  }

  if (!parsed || typeof parsed !== "object" || Array.isArray(parsed)) {
    throw new HttpError(400, "Expected object payload");
  }

  return parsed as Record<string, unknown>;
}

async function readText(request: IncomingMessage): Promise<string> {
  const chunks: Buffer[] = [];
  let bytes = 0;
  for await (const chunk of request) {
    const buffer = Buffer.isBuffer(chunk) ? chunk : Buffer.from(chunk);
    bytes += buffer.byteLength;
    if (bytes > maxRequestBodyBytes) {
      throw new HttpError(413, "Request body too large");
    }

    chunks.push(buffer);
  }

  return Buffer.concat(chunks).toString("utf8");
}

async function getDemoRun(): Promise<DemoRunSummary> {
  const now = Date.now();
  if (demoCache && now - demoCache.createdAt < demoCacheTtlMs) {
    return demoCache.summary;
  }

  if (!demoInFlight) {
    demoInFlight = runDemo().then((summary) => {
      demoCache = { createdAt: Date.now(), summary };
      return summary;
    });
  }

  try {
    return await demoInFlight;
  } finally {
    demoInFlight = undefined;
  }
}

function isInside(root: string, target: string): boolean {
  const normalizedRoot = resolve(root);
  const normalizedTarget = resolve(target);
  return normalizedTarget === normalizedRoot || normalizedTarget.startsWith(`${normalizedRoot}\\`) || normalizedTarget.startsWith(`${normalizedRoot}/`);
}

function expectString(value: unknown, name: string): string {
  if (typeof value !== "string" || value.length === 0) {
    throw new HttpError(400, `Expected non-empty string: ${name}`);
  }

  return value;
}

function expectApprovalAction(value: unknown): ApprovalActionId {
  if (value === "approve-pr" || value === "request-diff" || value === "reject-run") {
    return value;
  }

  throw new HttpError(400, "Expected valid approval action");
}

async function deliveryWasProcessed(dataDir: string, deliveryId: string): Promise<boolean> {
  try {
    const records = await readFile(join(dataDir, "webhook-runs.jsonl"), "utf8");
    return records
      .split("\n")
      .filter(Boolean)
      .some((line) => {
        try {
          return (JSON.parse(line) as { deliveryId?: string }).deliveryId === deliveryId;
        } catch {
          return false;
        }
      });
  } catch {
    return false;
  }
}

async function readLatestJsonlRecord(dataDir: string, fileName: string): Promise<unknown | undefined> {
  let file;
  try {
    file = await open(join(dataDir, fileName), "r");
  } catch {
    return undefined;
  }

  try {
    const metadata = await file.stat();
    const length = Math.min(metadata.size, maxLatestRunReadBytes);
    const start = metadata.size - length;
    const buffer = Buffer.alloc(length);
    await file.read(buffer, 0, length, start);

    const lines = buffer.toString("utf8").split("\n").filter(Boolean);
    let latest: unknown;
    let latestReceivedAt = Number.NEGATIVE_INFINITY;
    for (const line of lines) {
      try {
        const candidate = JSON.parse(line) as unknown;
        const receivedAt = receivedAtTimestamp(candidate);
        if (latest === undefined || receivedAt >= latestReceivedAt) {
          latest = candidate;
          latestReceivedAt = receivedAt;
        }
      } catch {
        // Ignore a partial or malformed trailing line.
      }
    }

    return latest;
  } finally {
    await file.close();
  }
}

function receivedAtTimestamp(value: unknown): number {
  if (typeof value !== "object" || value === null) {
    return Number.NEGATIVE_INFINITY;
  }

  const receivedAt = (value as { receivedAt?: unknown }).receivedAt;
  if (typeof receivedAt !== "string") {
    return Number.NEGATIVE_INFINITY;
  }

  const timestamp = Date.parse(receivedAt);
  return Number.isFinite(timestamp) ? timestamp : Number.NEGATIVE_INFINITY;
}

async function monitorTrueForgeTurn(
  dataDir: string,
  record: PersistedWebhookRunRecord,
  trueForgeRuntime: ReproSmithSessionStarter,
  githubClient: GitHubRestClientLike | undefined
): Promise<void> {
  if (!record.trueForge.session?.id || !record.trueForge.turn?.id || !trueForgeRuntime.subscribeToTurn) {
    return;
  }

  try {
    let events: TrueForgeRuntimeEvent[];
    let liveRecord = record;
    let liveEventIndex = 0;
    const persistTraceEvent: TrueForgeRuntimeEventListener = async (event) => {
      const projected = projectTrueForgeEvent(event, liveEventIndex);
      liveEventIndex += 1;
      if (projected.length === 0) return;
      const previousEvents = liveRecord.trueForge.events ?? [];
      const nextEvents = mergeHarnessEvents(previousEvents, projected);
      if (JSON.stringify(previousEvents) === JSON.stringify(nextEvents)) return;
      liveRecord = {
        ...liveRecord,
        trueForge: {
          ...liveRecord.trueForge,
          events: nextEvents
        }
      };
      await appendUpdatedLiveRecord(dataDir, liveRecord);
    };
    let streamError: unknown;
    try {
      events = await trueForgeRuntime.subscribeToTurn(record.trueForge.session.id, record.trueForge.turn.id, persistTraceEvent);
    } catch (error) {
      streamError = error;
      if (!trueForgeRuntime.listSessionEvents) {
        throw error;
      }
      events = [];
    }

    if (streamError !== undefined || !events.some((event) => event.type === "turn.done")) {
      if (!trueForgeRuntime.listSessionEvents) {
        throw streamError ?? new Error("TrueForge turn stream ended before turn.done");
      }

      for (let attempt = 0; attempt < 60; attempt += 1) {
        events = await trueForgeRuntime.listSessionEvents(record.trueForge.session.id);
        for (const event of events) {
          await persistTraceEvent(event);
        }
        if (events.some((event) => event.type === "turn.done")) {
          break;
        }
        await new Promise((resolve) => setTimeout(resolve, 10_000));
      }
    }

    const eventMetadata = mergeHarnessEvents(
      liveRecord.trueForge.events ?? [],
      events.flatMap((event, index) => projectTrueForgeEvent(event, index))
    );
    const completed = events.some((event) => event.type === "turn.done");
    const result = completed ? extractLiveProofResult(events, record) : undefined;
    let run = record.run;
    if (completed && result) {
      run = applyLiveProofResult(run, result);
    } else if (completed && canTransition(run.status, "failed")) {
      run = transitionRun(run, "failed", "TrueForge completed without a valid reprosmith.result contract");
    }
    const completedRecord: PersistedWebhookRunRecord = {
      ...liveRecord,
      run,
      trueForge: {
        ...liveRecord.trueForge,
        status: completed ? "completed" : "started",
        ...(completed
          ? result
            ? {}
            : { error: "TrueForge completed without a valid reprosmith.result contract" }
          : { error: "TrueForge turn is still running; completion has not been observed" }),
        events: eventMetadata,
        ...(result ? { result } : {})
      }
    };
    const labeledRecord = result ? await applyVerifiedLabel(completedRecord, githubClient) : completedRecord;
    const commentedRecord = await appendGitHubComment(labeledRecord, githubClient, result ? "completed" : "failed");
    await appendUpdatedLiveRecord(dataDir, commentedRecord);
  } catch (error) {
    console.error("TrueForge turn subscription failed", error);
    let failedRun = record.run;
    if (failedRun.status === "environment-building") {
      failedRun = transitionRun(failedRun, "failed", "TrueForge turn monitoring failed");
    }
    const failedRecord = {
      ...record,
      run: failedRun,
      trueForge: {
        ...record.trueForge,
        status: "failed",
        error: "TrueForge turn monitoring failed"
      }
    } satisfies PersistedWebhookRunRecord;
    const commentedRecord = await appendGitHubComment(failedRecord, githubClient, "failed");
    await appendUpdatedLiveRecord(dataDir, commentedRecord);
  }
}

function projectTrueForgeEvent(event: TrueForgeRuntimeEvent, fallbackIndex = 0): HarnessTraceEvent[] {
  const raw = unwrapRuntimeEvent(event.raw);
  if (!isRecord(raw)) return [];

  const type = typeof raw.type === "string" ? raw.type : event.type;
  const at = typeof raw.created_at === "string"
    ? raw.created_at
    : typeof raw.createdAt === "string"
      ? raw.createdAt
      : new Date().toISOString();
  const eventId = typeof raw.id === "string" ? raw.id : `${event.sequenceNumber ?? "event"}-${type}-${fallbackIndex}`;
  const toolCalls = Array.isArray(raw.tool_calls) ? raw.tool_calls : Array.isArray(raw.toolCalls) ? raw.toolCalls : [];
  const base = {
    sequenceNumber: event.sequenceNumber,
    at,
    type,
    source: "trueforge" as const
  };

  if (type === "model.message" && toolCalls.length > 0) {
    return toolCalls.flatMap((toolCall, index) => {
      if (!isRecord(toolCall) || !isRecord(toolCall.function)) return [];
      const name = typeof toolCall.function.name === "string" ? toolCall.function.name : "unknown";
      const args = parseToolArguments(toolCall.function.arguments);
      const category = categoryForTool(name);
      return [{
        ...base,
        id: `${eventId}:tool:${index}`,
        category,
        status: category === "sandbox" ? "running" as const : "info" as const,
        summary: summaryForTool(name, args),
        toolName: name,
        ...(typeof args.path === "string" ? { target: redactHarnessText(args.path) } : {}),
        ...(typeof args.issueNumber === "number" ? { target: `issue #${args.issueNumber}` } : {}),
        ...(typeof args.command === "string" ? { command: redactHarnessText(args.command) } : {}),
        ...(typeof args.sandboxId === "string" ? { sandboxId: args.sandboxId } : {}),
        ...(category === "mcp" ? { mcpServer: "reprosmith-github" } : {}),
        ...(category === "subagent" ? { subagent: typeof args.name === "string" ? args.name : name } : {})
      }];
    });
  }

  if (type === "model.message") {
    return [{
      ...base,
      id: eventId,
      category: "agent",
      status: "info",
      summary: summarizeAgentMessage(contentText(raw.content))
    }];
  }

  if (type === "tool.response") {
    const response = parseToolResponse(contentText(raw.content));
    const isSandbox = response.exitCode !== undefined || typeof response.result === "string";
    const category: HarnessEventCategory = isSandbox ? "sandbox" : "mcp";
    return [{
      ...base,
      id: eventId,
      category,
      status: response.exitCode !== undefined && response.exitCode !== 0 ? "failed" : "passed",
      summary: isSandbox ? "Sandbox command completed" : "MCP tool response received",
      ...(response.exitCode !== undefined ? { exitCode: response.exitCode } : {}),
      ...(response.stdout ? { stdout: redactHarnessText(response.stdout) } : {}),
      ...(response.stderr ? { stderr: redactHarnessText(response.stderr) } : {})
    }];
  }

  if (type === "sandbox.created") {
    const sandboxId = firstString(raw, ["sandbox_id", "sandboxId", "id"]);
    return [{
      ...base,
      id: eventId,
      category: "sandbox",
      status: "passed",
      summary: "Daytona sandbox created",
      ...(sandboxId ? { sandboxId } : {})
    }];
  }

  if (type.includes("subagent") || type.includes("delegate")) {
    return [{
      ...base,
      id: eventId,
      category: "subagent",
      status: type.includes("failed") ? "failed" : type.includes("created") || type.includes("started") ? "running" : "passed",
      summary: "Specialized agent activity recorded",
      subagent: firstString(raw, ["name", "agent", "subagent"]) ?? "specialized agent"
    }];
  }

  const category: HarnessEventCategory = type.startsWith("mcp.") ? "mcp" : type === "turn.done" || type === "turn.created" ? "session" : "agent";
  return [{
    ...base,
    id: eventId,
    category,
    status: type === "turn.done" ? "passed" : "info",
    summary: summaryForEvent(type)
  }];
}

function mergeHarnessEvents(existing: HarnessTraceEvent[], incoming: HarnessTraceEvent[]): HarnessTraceEvent[] {
  const merged = new Map(existing.map((event) => [event.id, event]));
  for (const event of incoming) {
    merged.set(event.id, event);
  }
  return [...merged.values()]
    .sort((left, right) => (left.sequenceNumber ?? Number.MAX_SAFE_INTEGER) - (right.sequenceNumber ?? Number.MAX_SAFE_INTEGER))
    .slice(-maxHarnessEvents);
}

function categoryForTool(name: string): HarnessEventCategory {
  if (name === "exec" || name === "shell" || name === "run_command") return "sandbox";
  if (name === "read_issue" || name === "read_file" || name === "add_verified_label" || name === "comment_on_issue") return "mcp";
  if (name === "create_fix_pull_request") return "github";
  if (name.includes("subagent") || name.includes("delegate") || name === "task") return "subagent";
  return "agent";
}

function summaryForTool(name: string, args: Record<string, unknown>): string {
  if (name === "exec" || name === "shell" || name === "run_command") return "Running a command in the Daytona sandbox";
  if (name === "read_file") return `Reading ${typeof args.path === "string" ? redactHarnessText(args.path) : "a repository file"} through GitHub MCP`;
  if (name === "read_issue") return `Reading ${typeof args.issueNumber === "number" ? `issue #${args.issueNumber}` : "the GitHub issue"} through GitHub MCP`;
  if (name === "create_fix_pull_request") return "Preparing the approved GitHub pull request write";
  if (categoryForTool(name) === "subagent") return `Delegating ${typeof args.name === "string" ? args.name : "a focused task"}`;
  return `Calling ${name}`;
}

function summaryForEvent(type: string): string {
  if (type === "mcp.initialize") return "GitHub MCP connection initialized";
  if (type === "turn.created") return "TrueForge turn created";
  if (type === "turn.done") return "TrueForge turn completed";
  return `${type.replace(/[._-]+/g, " ")} event received`;
}

function summarizeAgentMessage(value: string): string {
  const firstLine = redactHarnessText(value.replace(/```[\s\S]*?```/g, "").split("\n").map((line) => line.trim()).find(Boolean) ?? "");
  if (!firstLine) return "Agent status update received";
  if (/^(agent finding|observed|evidence|next action|created|reproduced|verified)\b/i.test(firstLine)) {
    return clampText(firstLine, 240);
  }
  return "Agent status update received";
}

function parseToolArguments(value: unknown): Record<string, unknown> {
  if (typeof value !== "string") return isRecord(value) ? value : {};
  try {
    const parsed = JSON.parse(value) as unknown;
    return isRecord(parsed) ? parsed : {};
  } catch {
    return {};
  }
}

function parseToolResponse(value: string): { result?: string; exitCode?: number | null; stdout?: string; stderr?: string } {
  try {
    const parsed = JSON.parse(value) as unknown;
    const outer = isRecord(parsed) && isRecord(parsed.response) ? parsed.response : parsed;
    if (!isRecord(outer)) return {};
    const result = typeof outer.result === "string" ? outer.result : undefined;
    const stdout = typeof outer.stdout === "string" ? outer.stdout : result;
    const stderr = typeof outer.stderr === "string" ? outer.stderr : undefined;
    return {
      ...(result ? { result } : {}),
      ...(typeof outer.exitCode === "number" ? { exitCode: outer.exitCode } : {}),
      ...(stdout ? { stdout } : {}),
      ...(stderr ? { stderr } : {})
    };
  } catch {
    return value ? { stdout: value } : {};
  }
}

function firstString(value: Record<string, unknown>, keys: string[]): string | undefined {
  for (const key of keys) {
    if (typeof value[key] === "string" && value[key]) return value[key];
  }
  return undefined;
}

function redactHarnessText(value: string): string {
  return clampText(
    value
      .replace(/Bearer\s+[A-Za-z0-9._-]+/gi, "Bearer [REDACTED]")
      .replace(/["']?(?:api[_-]?key|token|secret|password)["']?\s*[:=]\s*["']?[^"',\s}]+["']?/gi, "[REDACTED]")
      .replace(/(api[_-]?key|token|secret|password)\s*[:=]\s*[^\s,;]+/gi, "$1=[REDACTED]")
      .replace(/\bsk-[A-Za-z0-9_-]+\b/g, "[REDACTED]")
      .replace(/\bgh[pousr]_[A-Za-z0-9_]+\b/g, "[REDACTED]")
      .replace(/\s+/g, " ")
      .trim(),
    maxHarnessTextBytes
  );
}

function extractLiveProofResult(events: TrueForgeRuntimeEvent[], record: PersistedWebhookRunRecord): LiveProofResult | undefined {
  const done = [...events].reverse().find((event) => event.type === "turn.done");
  if (!done) {
    return undefined;
  }

  const streamedDeltaText = events
    .filter((event) => event.type === "model.message.delta")
    .flatMap((event) => resultOutputTexts(event.raw))
    .join("");
  const outputTexts = [
    ...resultOutputTexts(done.raw),
    ...(streamedDeltaText ? [streamedDeltaText] : []),
    ...events
      .filter((event) => event.type === "model.message")
      .reverse()
      .flatMap((event) => resultOutputTexts(event.raw)),
    ...[...events].reverse().flatMap((event) => resultOutputTexts(event.raw))
  ];
  const parsed = outputTexts
    .map((outputText) => parseResultJson(clampText(outputText, maxResultTextBytes)))
    .find((candidate): candidate is Record<string, unknown> => candidate !== undefined);
  if (!parsed) {
    return undefined;
  }

  const rawCandidatePatch = isRecord(parsed.candidatePatch)
    ? parsed.candidatePatch
    : isCandidatePatchObject(parsed)
      ? parsed
      : undefined;
  const status = parseLiveResultStatus(parsed.status) ?? (rawCandidatePatch ? "patch-ready" : undefined);
  if (!status) {
    return undefined;
  }

  const summary = clampText(typeof parsed.summary === "string" ? parsed.summary : `TrueForge reported ${status}`, 2_000);
  const proof = isRecord(parsed.proof)
    ? {
        ...(typeof parsed.proof.before === "string" ? { before: clampText(parsed.proof.before, 2_000) } : {}),
        ...(typeof parsed.proof.after === "string" ? { after: clampText(parsed.proof.after, 2_000) } : {}),
        ...(typeof parsed.proof.regressions === "string" ? { regressions: clampText(parsed.proof.regressions, 2_000) } : {}),
        ...(typeof parsed.proof.attempts === "string" ? { attempts: clampText(parsed.proof.attempts, 200) } : {})
      }
    : undefined;
  const candidatePatch = status === "patch-ready" || status === "verified"
    ? normalizeCandidatePatch(rawCandidatePatch, record, summary)
    : undefined;

  return {
    status: candidatePatch ? "patch-ready" : status,
    summary,
    ...(proof && Object.keys(proof).length > 0 ? { proof } : {}),
    ...(candidatePatch ? { candidatePatch } : {})
  };
}

function resultOutputTexts(value: unknown): string[] {
  const event = unwrapRuntimeEvent(value);
  if (!isRecord(event)) return [];

  const state = isRecord(event.state) ? event.state : undefined;
  const candidates = [
    state?.output,
    state?.result,
    event.output,
    event.result,
    event.content,
    event.delta,
    event.text,
    event.message,
    event.toolCalls,
    event.tool_calls
  ];

  return candidates.map(contentText).filter((text) => text.length > 0);
}

function normalizeCandidatePatch(value: unknown, record: PersistedWebhookRunRecord, summary: string): LiveCandidatePatch | undefined {
  if (!isRecord(value) || typeof value.title !== "string" || typeof value.body !== "string" || !Array.isArray(value.files)) {
    return undefined;
  }
  if (value.files.length === 0 || value.files.length > maxPatchFiles) {
    return undefined;
  }

  const files: Array<{ path: string; content: string }> = [];
  let totalBytes = 0;
  for (const file of value.files) {
    if (!isRecord(file) || typeof file.path !== "string" || typeof file.content !== "string") {
      return undefined;
    }
    if (
      file.path.length === 0 ||
      file.path.startsWith("/") ||
      file.path.includes("\\") ||
      file.path.split("/").some((segment) => segment.length === 0 || segment === "." || segment === "..")
    ) {
      return undefined;
    }
    const fileBytes = Buffer.byteLength(file.content, "utf8");
    totalBytes += fileBytes;
    if (fileBytes > maxPatchFileBytes || totalBytes > maxPatchTotalBytes) {
      return undefined;
    }
    files.push({ path: file.path, content: file.content });
  }

  const baseBranch = record.baseBranch;
  const branchName = `reprosmith/fix-${record.run.issue.issueNumber}-${createHash("sha256")
    .update(record.deliveryId)
    .digest("hex")
    .slice(0, 10)}`;
  const writeArguments = {
    owner: record.run.issue.owner,
    repo: record.run.issue.repo,
    baseBranch,
    branchName,
    title: clampText(value.title, 200),
    body: clampText(value.body || summary, 10_000),
    files
  };

  return {
    title: writeArguments.title,
    body: writeArguments.body,
    baseBranch: writeArguments.baseBranch,
    branchName: writeArguments.branchName,
    files: writeArguments.files,
    hash: approvalPayloadHash("create_fix_pull_request", writeArguments),
    verifiedAt: new Date().toISOString()
  };
}

function applyLiveProofResult(run: ReturnType<typeof createRun>, result: LiveProofResult) {
  if (result.candidatePatch) {
    for (const status of ["reproducing", "verified", "minimizing", "fixing", "validating", "patch-ready", "awaiting-approval"] as const) {
      if (canTransition(run.status, status)) {
        run = transitionRun(run, status, `TrueForge proof: ${status}`, {
          evidence: { summary: result.summary, ...(result.proof ? { proof: result.proof } : {}) }
        });
      }
    }
    return run;
  }

  if (result.status === "not-reproduced" && canTransition(run.status, "reproducing")) {
    run = transitionRun(run, "reproducing", "TrueForge attempted reproduction");
    if (canTransition(run.status, "not-reproduced")) {
      return transitionRun(run, "not-reproduced", result.summary);
    }
  }
  if (result.status === "verified" && canTransition(run.status, "reproducing")) {
    run = transitionRun(run, "reproducing", "TrueForge reproduced the issue");
    if (canTransition(run.status, "verified")) {
      return transitionRun(run, "verified", result.summary);
    }
  }
  if ((result.status === "blocked" || result.status === "failed") && canTransition(run.status, "failed")) {
    return transitionRun(run, "failed", result.summary);
  }
  return run;
}

function parseLiveResultStatus(value: unknown): LiveProofResult["status"] | undefined {
  return value === "patch-ready" || value === "verified" || value === "not-reproduced" || value === "blocked" || value === "failed"
    ? value
    : undefined;
}

function unwrapRuntimeEvent(value: unknown): unknown {
  if (isRecord(value) && isRecord(value.event)) return value.event;
  if (isRecord(value) && isRecord(value.data)) {
    if (isRecord(value.data.event)) return value.data.event;
    return value.data;
  }
  return value;
}

function contentText(value: unknown): string {
  if (typeof value === "string") {
    return value;
  }
  if (isRecord(value)) {
    if (typeof value.text === "string") return value.text;
    if ("content" in value) return contentText(value.content);
    if ("output" in value) return contentText(value.output);
    if ("delta" in value) return contentText(value.delta);
    if (isRecord(value.function) && typeof value.function.arguments === "string") return value.function.arguments;
    return "";
  }
  if (!Array.isArray(value)) {
    return "";
  }
  return value
    .map((part) => {
      if (typeof part === "string") return part;
      if (isRecord(part)) {
        if (typeof part.text === "string") return part.text;
        if ("content" in part) return contentText(part.content);
        if (isRecord(part.function) && typeof part.function.arguments === "string") return part.function.arguments;
      }
      return "";
    })
    .join("");
}

function parseResultJson(text: string): Record<string, unknown> | undefined {
  const candidates = balancedJsonObjects(text);
  let patchObject: Record<string, unknown> | undefined;
  for (const candidate of candidates) {
    try {
      const parsed = JSON.parse(candidate.trim()) as unknown;
      if (!isRecord(parsed)) continue;
      if (parsed.kind === "reprosmith.result" || isRecord(parsed.candidatePatch)) return parsed;
      if (!patchObject && isCandidatePatchObject(parsed)) patchObject = parsed;
    } catch {
      // Try the next bounded candidate.
    }
  }
  return patchObject;
}

function balancedJsonObjects(text: string): string[] {
  const objects: string[] = [];
  for (let start = 0; start < text.length; start += 1) {
    if (text[start] !== "{") continue;
    let depth = 0;
    let inString = false;
    let escaped = false;
    for (let index = start; index < text.length; index += 1) {
      const character = text[index];
      if (inString) {
        if (escaped) escaped = false;
        else if (character === "\\") escaped = true;
        else if (character === '"') inString = false;
        continue;
      }
      if (character === '"') {
        inString = true;
      } else if (character === "{") {
        depth += 1;
      } else if (character === "}") {
        depth -= 1;
        if (depth === 0) {
          objects.push(text.slice(start, index + 1));
          break;
        }
      }
    }
  }
  return objects;
}

function isCandidatePatchObject(value: Record<string, unknown>): boolean {
  return typeof value.title === "string" && typeof value.body === "string" && Array.isArray(value.files);
}

function clampText(value: string, maxBytes: number): string {
  if (Buffer.byteLength(value, "utf8") <= maxBytes) return value;
  return Buffer.from(value, "utf8").subarray(0, maxBytes).toString("utf8");
}

function bearerToken(request: IncomingMessage): string | undefined {
  const authorization = headerValue(request, "authorization");
  if (!authorization?.startsWith("Bearer ")) {
    return undefined;
  }

  return authorization.slice("Bearer ".length);
}

function headerValue(request: IncomingMessage, name: string): string | undefined {
  const value = request.headers[name];
  if (Array.isArray(value)) {
    return value[0];
  }

  return value;
}

function dashboardUrlFor(runId: string): string {
  const configuredBase = (process.env.APP_BASE_URL ?? process.env.PUBLIC_BASE_URL)?.trim().replace(/\/+$/, "");
  if (configuredBase) {
    return `${configuredBase}/runs/${encodeURIComponent(runId)}`;
  }

  return `http://localhost/runs/${encodeURIComponent(runId)}`;
}

function requiresExplicitTrigger(): boolean {
  return process.env.REPROSMITH_REQUIRE_TRIGGER_LABEL === "true";
}

function triggerLabel(): string {
  return process.env.REPROSMITH_TRIGGER_LABEL?.trim() || "reprosmith:run";
}

function hasTriggerLabel(webhook: ReturnType<typeof parseIssueWebhook>): boolean {
  return (webhook.issue.labels ?? []).some((label) => (typeof label === "string" ? label : label.name) === triggerLabel());
}

function hasExplicitTrigger(webhook: ReturnType<typeof parseIssueWebhook>): boolean {
  if (/(^|\n)\/reprosmith\s+run(?:\s|$)/i.test(webhook.issue.body ?? "")) {
    return true;
  }
  return (webhook.action === "opened" || webhook.action === "labeled") && hasTriggerLabel(webhook);
}

function resultStatusFor(actionId: ApprovalActionId) {
  if (actionId === "approve-pr") {
    return "approved";
  }

  if (actionId === "reject-run") {
    return "rejected";
  }

  return "awaiting-approval";
}

function messageFor(actionId: ApprovalActionId): string {
  if (actionId === "approve-pr") {
    return "PR write approval accepted by production API";
  }

  if (actionId === "reject-run") {
    return "Run rejection accepted by production API";
  }

  return "Diff review request accepted by production API";
}

function contentTypeFor(path: string): string {
  switch (extname(path)) {
    case ".css":
      return "text/css; charset=utf-8";
    case ".html":
      return "text/html; charset=utf-8";
    case ".js":
      return "text/javascript; charset=utf-8";
    case ".json":
      return "application/json; charset=utf-8";
    case ".svg":
      return "image/svg+xml";
    default:
      return "application/octet-stream";
  }
}

function sendJson(response: ServerResponse, statusCode: number, body: unknown): void {
  response.statusCode = statusCode;
  response.setHeader("Content-Type", "application/json");
  response.end(JSON.stringify(body));
}

class HttpError extends Error {
  constructor(
    readonly statusCode: number,
    readonly publicMessage: string
  ) {
    super(publicMessage);
    this.name = "HttpError";
  }
}

function githubClientFromEnv(): GitHubRestClientLike | undefined {
  const githubToken = process.env.GITHUB_TOKEN;
  return githubToken ? new GitHubRestClient({ token: githubToken }) : undefined;
}

function githubMcpHandlerFromEnv(githubClient: GitHubRestClientLike | undefined): McpRequestHandler | undefined {
  const mcpAuthToken = process.env.MCP_AUTH_TOKEN;
  if (!githubClient || !mcpAuthToken) return undefined;

  return createGitHubMcpHttpHandler({
    client: githubClient,
    authToken: mcpAuthToken
  });
}

function trueForgeRuntimeFromEnv(): ReproSmithSessionStarter | undefined {
  const baseUrl = process.env.TRUEFORGE_URL;
  const token = process.env.TRUEFORGE_API_KEY;
  if (!baseUrl || !token) {
    return undefined;
  }

  return new ReproSmithTrueForgeRuntime({
    baseUrl,
    token,
    modelName: process.env.MODEL_NAME ?? "glm-5.3",
    modelProvider: process.env.MODEL_PROVIDER ?? "agentrouter",
    mcpServerName: process.env.TRUEFORGE_MCP_SERVER_NAME ?? "reprosmith-github"
  });
}

function defaultStaticDir(): string {
  return resolve(dirname(fileURLToPath(import.meta.url)), "../../web/dist");
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}
