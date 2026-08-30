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
  TrueForgeTurn,
  TrueForgeRuntimeEventListener,
  TrueForgeRuntimeEvent
} from "@reprosmith/agent";
import { canTransition, createRun, scanIssueText, transitionRun } from "@reprosmith/core";
import { runDemo, type DemoRunSummary } from "@reprosmith/demo-runner";
import {
  GitHubRestClient,
  parseIssueCommentWebhook,
  parseIssueWebhook,
  verifyGitHubWebhook
} from "@reprosmith/github";

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
  rootCauseSummary?: string;
  proposedFixSummary?: string;
  baseSha?: string;
  patchDiff?: Array<{ path: string; before: string; after: string }>;
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
  requestProofContract?(sessionId: string): Promise<TrueForgeTurn>;
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
  approvalLabel?: { name: "reprosmith:awaiting-approval"; appliedAt?: string; error?: string };
  lifecycleLabels?: Array<{ name: string; appliedAt?: string; error?: string }>;
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
          githubClient,
          githubTools
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
  githubClient: GitHubRestClientLike | undefined,
  githubTools: GitHubWriteTools | undefined
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
  if (eventName && eventName !== "issues" && eventName !== "issue_comment") {
    sendJson(response, 202, { ignored: true, reason: `Unsupported GitHub event: ${eventName}` });
    return;
  }

  if (eventName === "issue_comment") {
    await handleGitHubIssueCommentWebhook(payload, response, dataDir, githubClient, githubTools);
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
  const labeledRecord = await syncLifecycleLabels(record, githubClient);
  const commentRecord = await appendGitHubComment(labeledRecord, githubClient, "started");
  await appendFile(join(dataDir, "webhook-runs.jsonl"), `${JSON.stringify(commentRecord)}\n`, "utf8");
  if (orchestration.trueForge.status === "started" && trueForgeRuntime?.subscribeToTurn) {
    void monitorTrueForgeTurn(dataDir, commentRecord, trueForgeRuntime, githubClient);
  }

  sendJson(response, 202, commentRecord);
}

interface GitHubApprovalCommand {
  runId?: string;
  patchHash?: string;
}

function parseGitHubApprovalCommand(body: string | null): GitHubApprovalCommand | undefined {
  if (body?.trim().toLowerCase() === "approve") {
    return {};
  }
  const match = body?.trim().match(/^\/reprosmith\s+approve\s+(\S+)\s+([a-f0-9]{64})$/i);
  return match ? { runId: match[1], patchHash: match[2].toLowerCase() } : undefined;
}

function isMaintainerComment(authorAssociation: string | undefined, permission: string | undefined): boolean {
  const association = authorAssociation?.toUpperCase();
  if (association === "OWNER") return true;
  if (association !== "MEMBER" && association !== "COLLABORATOR") return false;
  return ["admin", "maintain", "write"].includes(permission?.toLowerCase() ?? "");
}

async function handleGitHubIssueCommentWebhook(
  payload: string,
  response: ServerResponse,
  dataDir: string,
  githubClient: GitHubRestClientLike | undefined,
  githubTools: GitHubWriteTools | undefined
): Promise<void> {
  let webhook: ReturnType<typeof parseIssueCommentWebhook>;
  try {
    webhook = parseIssueCommentWebhook(payload);
  } catch {
    throw new HttpError(400, "Malformed GitHub issue comment webhook payload");
  }

  if (webhook.action !== "created") {
    sendJson(response, 202, { ignored: true, reason: `Unsupported issue comment action: ${webhook.action}` });
    return;
  }

  const command = parseGitHubApprovalCommand(webhook.comment.body);
  if (!command) {
    sendJson(response, 202, { ignored: true, reason: "No ReproSmith approval command" });
    return;
  }

  const login = webhook.comment.user?.login;
  if (!login) {
    sendJson(response, 403, { error: "GitHub approval commenter could not be identified" });
    return;
  }

  let permission: string | undefined;
  if (webhook.comment.author_association?.toUpperCase() !== "OWNER") {
    if (!githubClient?.getCollaboratorPermission) {
      sendJson(response, 403, { error: "Maintainer permission could not be verified" });
      return;
    }
    try {
      permission = (await githubClient.getCollaboratorPermission(
        webhook.repository.owner.login,
        webhook.repository.name,
        login
      )).permission;
    } catch {
      sendJson(response, 403, { error: "GitHub commenter is not a repository maintainer" });
      return;
    }
  }

  if (!isMaintainerComment(webhook.comment.author_association, permission)) {
    sendJson(response, 403, { error: "GitHub commenter is not a repository maintainer" });
    return;
  }

  const repository = `${webhook.repository.owner.login}/${webhook.repository.name}`;
  const liveRecord = command.runId
    ? await findPersistedRunById(dataDir, command.runId)
    : await findLatestAwaitingRunByIssue(dataDir, repository, webhook.issue.number);
  if (
    !liveRecord ||
    liveRecord.repository !== repository ||
    liveRecord.run.issue.issueNumber !== webhook.issue.number
  ) {
    sendJson(response, 409, { error: "Approval command does not match a persisted GitHub run" });
    return;
  }

  const candidateHash = liveRecord.trueForge.result?.candidatePatch?.hash;
  const patchHash = command.patchHash ?? candidateHash;
  if (!patchHash) {
    sendJson(response, 409, { error: "No approved candidate patch is available for this issue" });
    return;
  }
  const result = await executeApproval(dataDir, liveRecord.run.id, "approve-pr", patchHash, githubTools, githubClient);
  sendJson(response, result.statusCode, result.body);
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
  sendJson(response, 200, publicRunPayload(hydratePersistedPullRequest(ensureDashboardUrl(refreshed))));
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
  sendJson(response, 200, publicRunPayload(hydratePersistedPullRequest(ensureDashboardUrl(refreshed))));
}

function publicRunPayload(value: unknown): unknown {
  if (!isRecord(value) || !isRecord(value.trueForge)) return value;

  const publicRun = isRecord(value.run) && Array.isArray(value.run.events)
    ? {
        ...value.run,
        events: value.run.events.map((event) => {
          if (!isRecord(event)) return event;
          const { evidence: _evidence, ...publicEvent } = event;
          return {
            ...publicEvent,
            ...(typeof publicEvent.message === "string" ? { message: safePublicMarkdown(publicEvent.message) } : {})
          };
        })
      }
    : value.run;
  const { session: _session, turn: _turn, ...trueForge } = value.trueForge;
  const result = isRecord(trueForge.result)
    ? {
        ...trueForge.result,
        ...(typeof trueForge.result.summary === "string" ? { summary: safePublicMarkdown(trueForge.result.summary) } : {}),
        ...(typeof trueForge.result.rootCauseSummary === "string" ? { rootCauseSummary: safePublicMarkdown(trueForge.result.rootCauseSummary) } : {}),
        ...(typeof trueForge.result.proposedFixSummary === "string" ? { proposedFixSummary: safePublicMarkdown(trueForge.result.proposedFixSummary) } : {}),
        ...(isRecord(trueForge.result.proof)
          ? {
              proof: Object.fromEntries(
                Object.entries(trueForge.result.proof).map(([key, field]) => [key, typeof field === "string" ? safePublicMarkdown(field) : field])
              )
            }
          : {}),
        ...(isRecord(trueForge.result.candidatePatch) && typeof trueForge.result.candidatePatch.body === "string"
          ? { candidatePatch: { ...trueForge.result.candidatePatch, body: safePublicMarkdown(trueForge.result.candidatePatch.body) } }
          : {})
      }
    : trueForge.result;
  const events = Array.isArray(trueForge.events)
    ? trueForge.events.map((event, index) => {
        if (!isRecord(event)) return event;
        const { sandboxId: _sandboxId, sequenceNumber: _sequenceNumber, mcpServer: _mcpServer, ...publicEvent } = event;
        return {
          ...Object.fromEntries(
          Object.entries(publicEvent).map(([key, field]) => [
            key,
            typeof field === "string" && ["summary", "target", "command", "stdout", "stderr", "artifact", "subagent"].includes(key)
              ? safePublicMarkdown(field)
              : field
          ])
          ),
          id: `event-${index + 1}`,
          ...(publicEvent.category === "session" ? { category: "agent" } : {}),
          ...(typeof publicEvent.type === "string"
            ? { type: publicEvent.type.replace(/session/gi, "run").replace(/turn/gi, "step") }
            : {})
        };
      })
    : trueForge.events;

  return { ...value, run: publicRun, trueForge: { ...trueForge, result, events } };
}

function safePublicMarkdown(value: string): string {
  return value
    .replace(/(?:\/tmp|\/workspace|\/home\/[^/\s]+)\/[^\s),;]+/g, "[sandbox path]")
    .replace(/\b[A-Za-z]:\\[^\s),;]+/g, "[local path]")
    .replace(/<[^>\n]*>/g, "")
    .split(/\r?\n/)
    .map((line) => redactHarnessText(line).trimEnd())
    .join("\n")
    .replace(/\n{3,}/g, "\n\n")
    .trim();
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
  const result = await executeApproval(dataDir, runId, actionId, patchHash, githubTools, githubClient);
  sendJson(response, result.statusCode, result.body);
}

interface ApprovalExecutionResult {
  statusCode: number;
  body: unknown;
}

async function executeApproval(
  dataDir: string,
  runId: string,
  actionId: ApprovalActionId,
  patchHash: string,
  githubTools: GitHubWriteTools | undefined,
  githubClient: GitHubRestClientLike | undefined
): Promise<ApprovalExecutionResult> {
  const liveRecord = await findPersistedRunById(dataDir, runId);
  if (!liveRecord) {
    const latestRun = await getDemoRun();
    if (latestRun.run.id !== runId || latestRun.candidatePatch.hash !== patchHash) {
      return { statusCode: 409, body: { error: "Approval payload does not match the current run" } };
    }

    const receipt = buildApprovalReceipt(runId, actionId, patchHash, resultStatusFor(actionId), messageFor(actionId));
    await appendApprovalReceipt(dataDir, receipt);
    return { statusCode: 200, body: receipt };
  }

  const candidatePatch = liveRecord.trueForge.result?.candidatePatch;
  if (!candidatePatch || candidatePatch.hash !== patchHash) {
    return { statusCode: 409, body: { error: "Approval payload does not match the live candidate patch" } };
  }
  const previousReceipt = await findApprovalReceipt(dataDir, runId, actionId, patchHash);
  if (previousReceipt?.resultStatus === "writing") {
    return { statusCode: 409, body: { error: "This approval is already being processed" } };
  }
  if (previousReceipt && previousReceipt.resultStatus !== "write-failed") {
    return { statusCode: 200, body: previousReceipt };
  }
  if (liveRecord.run.status !== "awaiting-approval") {
    return { statusCode: 409, body: { error: "Live run is not awaiting approval" } };
  }

  if (actionId !== "approve-pr") {
    let run = liveRecord.run;
    if (actionId === "reject-run" && canTransition(run.status, "rejected")) {
      run = transitionRun(run, "rejected", "Maintainer rejected the live candidate patch");
    }
    const receipt = buildApprovalReceipt(runId, actionId, patchHash, resultStatusFor(actionId), messageFor(actionId));
    await appendApprovalReceipt(dataDir, receipt);
    const baseRecord: PersistedWebhookRunRecord = {
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
    };
    const cleanedRecord = actionId === "reject-run"
      ? await removeAwaitingApprovalLabel(baseRecord, githubClient)
      : baseRecord;
    const statusLabeledRecord = await syncLifecycleLabels(cleanedRecord, githubClient);
    const updatedRecord = await appendGitHubComment(statusLabeledRecord, githubClient, "approval");
    await appendUpdatedLiveRecord(dataDir, updatedRecord);
    return { statusCode: 200, body: receipt };
  }

  if (!githubTools) {
    return { statusCode: 503, body: { error: "GitHub write tools are not configured" } };
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
    return { statusCode: 409, body: { error: "Live candidate patch hash is invalid" } };
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
    return { statusCode: 502, body: { error: failedReceipt.message } };
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
  const cleanedRecord = await removeAwaitingApprovalLabel(updatedRecord, githubClient);
  const statusLabeledRecord = await syncLifecycleLabels(cleanedRecord, githubClient);
  const commentedRecord = await appendGitHubComment(statusLabeledRecord, githubClient, "approval");
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
  return { statusCode: 200, body: receipt };
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

const lifecycleLabelDefinitions = [
  { name: "reprosmith:triaging", color: "1d5fd1", description: "ReproSmith is triaging this issue" },
  { name: "reprosmith:needs-info", color: "a85b00", description: "ReproSmith needs more issue information" },
  { name: "reprosmith:not-reproduced", color: "6e7781", description: "ReproSmith could not reproduce this issue" },
  { name: "reprosmith:security-review", color: "b42318", description: "ReproSmith held this issue for security review" },
  { name: "reprosmith:pr-created", color: "1a7f37", description: "ReproSmith created a draft pull request" }
] as const;

function desiredLifecycleLabels(record: PersistedWebhookRunRecord): string[] {
  if (!record.scan.safeToExecute) return ["reprosmith:security-review"];
  if (record.run.status === "pr-created") return ["reprosmith:pr-created"];
  if (record.run.status === "awaiting-approval") return [];
  if (record.run.status === "needs-info") return ["reprosmith:needs-info"];
  if (record.run.status === "not-reproduced") return ["reprosmith:not-reproduced"];
  if (record.run.status === "triaging" || record.trueForge.status === "started") return ["reprosmith:triaging"];
  return [];
}

async function syncLifecycleLabels(
  record: PersistedWebhookRunRecord,
  githubClient: GitHubRestClientLike | undefined
): Promise<PersistedWebhookRunRecord> {
  if (!githubClient) return record;
  const desired = desiredLifecycleLabels(record);
  const owner = record.run.issue.owner;
  const repo = record.run.issue.repo;
  const issueNumber = record.run.issue.issueNumber;
  const applied: Array<{ name: string; appliedAt?: string; error?: string }> = [];

  for (const labelName of desired) {
    const definition = lifecycleLabelDefinitions.find((label) => label.name === labelName);
    if (!definition) continue;
    try {
      try {
        await githubClient.updateLabel?.(owner, repo, definition.name, definition.color, definition.description);
      } catch {
        if (!githubClient.createLabel) throw new Error("GitHub label is unavailable");
        await githubClient.createLabel(owner, repo, definition.name, definition.color, definition.description);
      }
      await githubClient.addLabels(owner, repo, issueNumber, [definition.name]);
      applied.push({ name: definition.name, appliedAt: new Date().toISOString() });
    } catch {
      applied.push({ name: definition.name, error: "GitHub did not accept the lifecycle label request" });
    }
  }

  if (githubClient.removeLabel) {
    for (const definition of lifecycleLabelDefinitions) {
      if (desired.includes(definition.name)) continue;
      try {
        await githubClient.removeLabel(owner, repo, issueNumber, definition.name);
      } catch {
        // A missing label is already in the desired state.
      }
    }
  }

  return { ...record, lifecycleLabels: applied };
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
    const labelName = "reprosmith:verified";
    const labelColor = "8250df";
    try {
      await githubClient.updateLabel?.(owner, repo, labelName, labelColor, "Issue verified by reproducible evidence");
    } catch {
      // The label may not exist yet; addLabels below will take the create path.
    }
    try {
      await githubClient.addLabels(owner, repo, issueNumber, [labelName]);
    } catch (error) {
      if (!githubClient.createLabel) throw error;
      await githubClient.createLabel(owner, repo, labelName, labelColor, "Issue verified by reproducible evidence");
      await githubClient.addLabels(owner, repo, issueNumber, [labelName]);
    }
    await githubClient.updateLabel?.(owner, repo, labelName, labelColor, "Issue verified by reproducible evidence");
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

async function applyAwaitingApprovalLabel(
  record: PersistedWebhookRunRecord,
  githubClient: GitHubRestClientLike | undefined
): Promise<PersistedWebhookRunRecord> {
  if (
    !githubClient ||
    record.approvalLabel ||
    record.run.status !== "awaiting-approval" ||
    !hasGenuineProof(record.trueForge.result)
  ) {
    return record;
  }

  try {
    const owner = record.run.issue.owner;
    const repo = record.run.issue.repo;
    const issueNumber = record.run.issue.issueNumber;
    const labelName = "reprosmith:awaiting-approval";
    const labelColor = "d1242f";
    try {
      await githubClient.updateLabel?.(owner, repo, labelName, labelColor, "Verified patch is waiting for maintainer approval");
    } catch {
      // The label may not exist yet; addLabels below will take the create path.
    }
    try {
      await githubClient.addLabels(owner, repo, issueNumber, [labelName]);
    } catch (error) {
      if (!githubClient.createLabel) throw error;
      await githubClient.createLabel(owner, repo, labelName, labelColor, "Verified patch is waiting for maintainer approval");
      await githubClient.addLabels(owner, repo, issueNumber, [labelName]);
    }
    await githubClient.updateLabel?.(owner, repo, labelName, labelColor, "Verified patch is waiting for maintainer approval");
    return {
      ...record,
      approvalLabel: { name: labelName, appliedAt: new Date().toISOString() }
    };
  } catch {
    return {
      ...record,
      approvalLabel: {
        name: "reprosmith:awaiting-approval",
        error: "GitHub did not accept the approval label request"
      }
    };
  }
}

async function removeAwaitingApprovalLabel(
  record: PersistedWebhookRunRecord,
  githubClient: GitHubRestClientLike | undefined
): Promise<PersistedWebhookRunRecord> {
  if (!githubClient?.removeLabel || !record.approvalLabel?.appliedAt) {
    return record;
  }

  try {
    await githubClient.removeLabel(
      record.run.issue.owner,
      record.run.issue.repo,
      record.run.issue.issueNumber,
      "reprosmith:awaiting-approval"
    );
    return { ...record, approvalLabel: undefined };
  } catch {
    return record;
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
    if (record.githubStatusComment?.id !== undefined && githubClient.updateIssueComment) {
      const updated = await githubClient.updateIssueComment(
        record.run.issue.owner,
        record.run.issue.repo,
        record.githubStatusComment.id,
        body
      );
      return {
        ...record,
        githubComments: (record.githubComments ?? [{
          id: record.githubStatusComment.id,
          url: record.githubStatusComment.url,
          kind: "started",
          createdAt: record.receivedAt
        }]).map((comment) => comment.id === record.githubStatusComment?.id
          ? { ...comment, kind, url: updated.html_url ?? comment.url }
          : comment),
        githubStatusComment: {
          id: updated.id ?? record.githubStatusComment.id,
          url: updated.html_url ?? record.githubStatusComment.url
        }
      };
    }
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
      githubComments: [comment],
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

export function buildGitHubStatusComment(record: PersistedWebhookRunRecord, kind: GitHubCommentKind): string {
  const status = githubCommentStatus(record);
  const result = record.trueForge.result;
  const pullRequest = result?.pullRequest;
  const reviewUrl = record.dashboardUrl ? `${record.dashboardUrl.replace(/\/$/, "")}/review` : "#";
  const runUrl = record.dashboardUrl ?? "#";
  const lines = [
    `<!-- reprosmith-run:${record.run.id} -->`,
    `## ReproSmith · ${status.label}`,
    "",
    `Issue #${record.run.issue.issueNumber}: ${safeCommentText(record.issueTitle, 240)}`,
    `**Status:** ${status.detail}`,
    "",
    `[Open ReproSmith run →](${record.dashboardUrl ?? "#"})`
  ];

  if (!record.scan.safeToExecute || record.run.status === "security-review") {
    lines.push(
      "",
      "ReproSmith detected potentially unsafe reproduction instructions and held execution.",
      "",
      "**Execution:** Blocked",
      "**GitHub writes:** None",
      "",
      `**[Review security analysis ->](${runUrl})**`
    );
  } else if (record.run.status === "needs-info") {
    lines.push(
      "",
      "ReproSmith could not build a reliable reproduction from the current report.",
      "",
      "**Next step:** Add the missing runtime, input, or expected-output details and trigger a new run.",
      "",
      `**[View investigation ->](${runUrl})**`
    );
  } else if (record.run.status === "not-reproduced") {
    lines.push(
      "",
      "ReproSmith built the reported environment but did not observe the claimed failure.",
      "",
      `**Reproduction attempts:** ${safeCommentText(result?.proof?.attempts ?? "No matching failure observed", 180)}`,
      "",
      "This does not prove the bug does not exist.",
      "",
      `**[View evidence ->](${runUrl})**`
    );
  } else if (result?.candidatePatch && hasGenuineProof(result)) {
    lines.push(
      "",
      "### Evidence",
      `- **Reproduction:** ${commentProofText(result.proof?.attempts, "3/3 matching failures", 180)}`,
      `- **Before:** ${commentProofText(result.proof?.before, "Failure observed", 260)}`,
      `- **After:** ${commentProofText(result.proof?.after, "Passes after patch", 260)}`,
      `- **Regression suite:** ${commentProofText(result.proof?.regressions, "Passed", 260)}`,
      "",
      "### Root cause",
      safeCommentMarkdown(result.rootCauseSummary ?? summarizeCommentText(result.summary), 360),
      "",
      "### Proposed fix",
      safeCommentMarkdown(result.proposedFixSummary ?? summarizeCommentText(result.candidatePatch.body), 360),
      "",
      `**Patch:** ${result.candidatePatch.files.length} file${result.candidatePatch.files.length === 1 ? "" : "s"} · review on the dashboard before approval`,
      `**Files:** ${result.candidatePatch.files.map((file) => `\`${safeCommentText(file.path, 180)}\``).join(", ")}`
    );
    if (record.run.status === "awaiting-approval") {
      lines.push(
        "",
        "> ⏸ **TrueForge is paused. No branch, commit, or pull request has been created.**",
        "",
        `**[Review evidence & approve patch →](${reviewUrl})**`
      );
    }
  } else if (result && hasGenuineProof(result)) {
    lines.push(
      "",
      "### Evidence",
      `- **Reproduction:** ${commentProofText(result.proof?.attempts, "3/3 matching failures", 180)}`,
      `- **Before:** ${commentProofText(result.proof?.before, "Failure observed", 260)}`,
      `- **After:** ${commentProofText(result.proof?.after, "Passes after patch", 260)}`,
      `- **Regression suite:** ${commentProofText(result.proof?.regressions, "Passed", 260)}`,
      "",
      "### Finding",
      safeCommentMarkdown(result.rootCauseSummary ?? summarizeCommentText(result.summary), 360),
      "",
      "No candidate patch was returned, so ReproSmith did not request repository write approval.",
      `**[View verification evidence →](${runUrl})**`
    );
  } else if (record.run.status === "failed") {
    lines.push(
      "",
      "> No genuine proof contract was returned. No verified label or repository mutation was made.",
      "",
      "Review the run for bounded failure details."
    );
  }
  if (pullRequest) {
    lines.push(
      "",
      "### Validation complete",
      "- ✅ Issue verified",
      "- ✅ Candidate patch validated",
      "- ✅ Maintainer approved",
      `- ✅ Draft PR created: [#${pullRequest.number}](${pullRequest.url})`,
      "",
      `**[View verification evidence →](${record.dashboardUrl ?? "#"})**`
    );
  }

  return lines.join("\n");
}

function safeCommentText(value: string, maxBytes: number): string {
  return clampCommentText(redactHarnessText(value), maxBytes);
}

function safeCommentMarkdown(value: string, maxBytes: number): string {
  const redactedLines = value
    .replace(/<[^>\n]*>/g, "")
    .split(/\r?\n/)
    .map((line) => redactHarnessText(line).trimEnd())
    .join("\n")
    .replace(/\n{3,}/g, "\n\n")
    .trim();
  return clampCommentText(redactedLines, maxBytes);
}

function clampCommentText(value: string, maxBytes: number): string {
  if (Buffer.byteLength(value, "utf8") <= maxBytes) return value;

  const suffix = "...";
  const byteLimit = Math.max(0, maxBytes - Buffer.byteLength(suffix, "utf8"));
  let prefix = "";
  for (const character of value) {
    if (Buffer.byteLength(prefix + character, "utf8") > byteLimit) break;
    prefix += character;
  }

  const minimumBoundary = Math.floor(prefix.length * 0.6);
  const boundary = Math.max(
    prefix.lastIndexOf(" "),
    prefix.lastIndexOf("\n"),
    prefix.lastIndexOf("."),
    prefix.lastIndexOf(","),
    prefix.lastIndexOf(";")
  );
  if (boundary >= minimumBoundary) prefix = prefix.slice(0, boundary + (prefix[boundary] === "." ? 1 : 0));
  return `${prefix.trimEnd()}${suffix}`;
}

function commentProofText(value: string | undefined, fallback: string, maxBytes: number): string {
  return safeCommentText(summarizeCommentText(value ?? fallback), maxBytes);
}

function safeCodeText(value: string, maxBytes: number): string {
  return clampText(
    value
      .replace(/Bearer\s+[A-Za-z0-9._-]+/gi, "Bearer [REDACTED]")
      .replace(/(?:api[_-]?key|token|secret|password)\s*[:=]\s*[^\s,;]+/gi, "[REDACTED]")
      .replace(/\bsk-[A-Za-z0-9_-]+\b/g, "[REDACTED]")
      .replace(/\bgh[pousr]_[A-Za-z0-9_]+\b/g, "[REDACTED]")
      .replace(/`{4,}/g, "```")
      .trim(),
    maxBytes
  );
}

function commentUpdateLabel(kind: GitHubCommentKind): string {
  if (kind === "started") return "TrueForge handoff started";
  if (kind === "completed") return "Proof processing completed";
  if (kind === "failed") return "Run stopped";
  return "Maintainer decision recorded";
}

function summarizeCommentText(value: string): string {
  const compact = value.replace(/\s+/g, " ").trim();
  const sentences = compact.match(/[^.!?]+[.!?](?:\s|$)/g)?.slice(0, 2).join(" ").trim();
  return clampText(sentences || compact, 360);
}

function githubCommentStatus(record: PersistedWebhookRunRecord): { label: string; detail: string } {
  if (!record.scan.safeToExecute || record.run.status === "security-review") {
    return { label: "Security review", detail: "Execution was held after the issue text failed the safety scan." };
  }
  if (record.run.status === "pr-created") {
    return { label: "Fix proposed", detail: "Approved patch validated; draft pull request created." };
  }
  if (record.run.status === "needs-info") {
    return { label: "Needs information", detail: "The issue needs more detail before ReproSmith can reproduce it." };
  }
  if (record.run.status === "not-reproduced") {
    return { label: "Not reproduced", detail: "The reported failure was not observed in the investigated environment." };
  }
  if (record.run.status === "awaiting-approval") {
    return { label: "Patch ready for review", detail: "Verified evidence is ready; TrueForge is paused before GitHub writes." };
  }
  if (record.run.status === "patch-ready" || record.run.status === "verified") {
    return { label: "Verified", detail: "The reported failure is backed by executable evidence." };
  }
  if (record.run.status === "rejected") {
    return { label: "Run rejected", detail: "The run was stopped before repository mutation." };
  }
  if (record.run.status === "failed") {
    return { label: "Run failed", detail: record.trueForge.error ?? "TrueForge did not complete successfully." };
  }
  if (record.trueForge.status === "started") {
    if (record.run.status === "reproducing") {
      return { label: "Reproducing", detail: "TrueForge is running the reported scenario in an isolated environment." };
    }
    if (record.run.status === "environment-building") {
      return { label: "Environment building", detail: "TrueForge is preparing an isolated environment for reproduction." };
    }
    return { label: "Investigating", detail: "TrueForge is inspecting the issue and collecting executable evidence." };
  }
  return { label: "Investigation queued", detail: "ReproSmith accepted the signed issue and is preparing the investigation." };
}

async function findPersistedRunById(dataDir: string | undefined, runId: string): Promise<PersistedWebhookRunRecord | undefined> {
  if (!dataDir) return undefined;
  try {
    let match: PersistedWebhookRunRecord | undefined;
    for await (const line of readJsonlLines(join(dataDir, "webhook-runs.jsonl"))) {
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

async function findLatestAwaitingRunByIssue(
  dataDir: string,
  repository: string,
  issueNumber: number
): Promise<PersistedWebhookRunRecord | undefined> {
  try {
    let match: PersistedWebhookRunRecord | undefined;
    for await (const line of readJsonlLines(join(dataDir, "webhook-runs.jsonl"))) {
      try {
        const record = JSON.parse(line) as PersistedWebhookRunRecord;
        if (
          record.repository === repository &&
          record.run?.issue.issueNumber === issueNumber &&
          record.run.status === "awaiting-approval" &&
          (!match || Date.parse(record.run.createdAt) > Date.parse(match.run.createdAt))
        ) {
          match = record;
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

async function findApprovalReceipt(
  dataDir: string,
  runId: string,
  actionId: ApprovalActionId,
  patchHash: string
): Promise<ApprovalReceipt | undefined> {
  try {
    let match: ApprovalReceipt | undefined;
    for await (const line of readJsonlLines(join(dataDir, "approvals.jsonl"))) {
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
    const needle = `"deliveryId":${JSON.stringify(deliveryId)}`;
    for await (const line of readJsonlLines(join(dataDir, "webhook-runs.jsonl"))) {
      if (line.includes(needle)) {
        return true;
      }
    }
    return false;
  } catch {
    return false;
  }
}

async function* readJsonlLines(path: string): AsyncGenerator<string> {
  const maxLineBytes = 4 * 1024 * 1024;
  const input = createReadStream(path, { encoding: "utf8", highWaterMark: 64 * 1024 });
  let buffer = "";
  let discardingOversizedLine = false;

  try {
    for await (const chunk of input) {
      let nextChunk = chunk as string;
      if (discardingOversizedLine) {
        const newline = nextChunk.indexOf("\n");
        if (newline < 0) continue;
        discardingOversizedLine = false;
        nextChunk = nextChunk.slice(newline + 1);
      }

      buffer += nextChunk;
      let newline = buffer.indexOf("\n");
      while (newline >= 0) {
        const line = buffer.slice(0, newline).replace(/\r$/, "");
        buffer = buffer.slice(newline + 1);
        if (Buffer.byteLength(line, "utf8") <= maxLineBytes && line.length > 0) {
          yield line;
        }
        newline = buffer.indexOf("\n");
      }

      if (Buffer.byteLength(buffer, "utf8") > maxLineBytes) {
        buffer = "";
        discardingOversizedLine = true;
      }
    }

    if (!discardingOversizedLine && buffer.length > 0 && Buffer.byteLength(buffer, "utf8") <= maxLineBytes) {
      yield buffer.replace(/\r$/, "");
    }
  } finally {
    input.destroy();
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

    let completed = events.some((event) => event.type === "turn.done");
    let result = completed ? extractLiveProofResult(events, record) : undefined;
    if (result) {
      result = await hydratePatchEvidence(result, record, githubClient);
    }
    if (completed && !result && trueForgeRuntime.listSessionEvents) {
      try {
        const persistedEvents = await trueForgeRuntime.listSessionEvents(record.trueForge.session.id);
        if (persistedEvents.length > 0) {
          events = [...events, ...persistedEvents];
          for (const event of persistedEvents) {
            await persistTraceEvent(event);
          }
          result = extractLiveProofResult(events, record);
          if (result) {
            result = await hydratePatchEvidence(result, record, githubClient);
          }
        }
      } catch (error) {
        console.error("TrueForge persisted event refresh failed", error);
      }
    }
    if (completed && !result && trueForgeRuntime.requestProofContract) {
      try {
        const recoveryTurn = await trueForgeRuntime.requestProofContract(record.trueForge.session.id);
        liveRecord = {
          ...liveRecord,
          trueForge: {
            ...liveRecord.trueForge,
            status: "started",
            turn: recoveryTurn,
            error: "TrueForge proof contract recovery requested"
          }
        };
        await appendUpdatedLiveRecord(dataDir, liveRecord);
        const recoveryEvents = await trueForgeRuntime.subscribeToTurn(
          record.trueForge.session.id,
          recoveryTurn.id,
          persistTraceEvent
        );
        events = [...events, ...recoveryEvents];
        completed = events.some((event) => event.type === "turn.done");
        result = completed ? extractLiveProofResult(events, record) : undefined;
        if (result) {
          result = await hydratePatchEvidence(result, record, githubClient);
        }
      } catch (error) {
        console.error("TrueForge proof contract recovery failed", error);
      }
    }
    const eventMetadata = mergeHarnessEvents(
      liveRecord.trueForge.events ?? [],
      events.flatMap((event, index) => projectTrueForgeEvent(event, index))
    );
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
            ? { error: undefined }
            : { error: "TrueForge completed without a valid reprosmith.result contract" }
          : { error: "TrueForge turn is still running; completion has not been observed" }),
        events: eventMetadata,
        ...(result ? { result } : {})
      }
    };
    const labeledRecord = await syncLifecycleLabels(completedRecord, githubClient);
    const verifiedRecord = result ? await applyVerifiedLabel(labeledRecord, githubClient) : labeledRecord;
    const approvalLabeledRecord = result
      ? await applyAwaitingApprovalLabel(verifiedRecord, githubClient)
      : verifiedRecord;
    const commentedRecord = await appendGitHubComment(approvalLabeledRecord, githubClient, result ? "completed" : "failed");
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
      summary: summarizeAgentMessage(clampText(contentText(raw.content), maxHarnessTextBytes))
    }];
  }

  if (type === "tool.response") {
    const response = parseToolResponse(clampText(contentText(raw.content), maxResultTextBytes));
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
  if (name === "read_issue" || name === "read_file" || name === "submit_reprosmith_result" || name === "add_verified_label" || name === "comment_on_issue") return "mcp";
  if (name === "create_fix_pull_request") return "github";
  if (name.includes("subagent") || name.includes("delegate") || name === "task") return "subagent";
  return "agent";
}

function summaryForTool(name: string, args: Record<string, unknown>): string {
  if (name === "exec" || name === "shell" || name === "run_command") return "Running a command in the Daytona sandbox";
  if (name === "read_file") return `Reading ${typeof args.path === "string" ? redactHarnessText(args.path) : "a repository file"} through GitHub MCP`;
  if (name === "read_issue") return `Reading ${typeof args.issueNumber === "number" ? `issue #${args.issueNumber}` : "the GitHub issue"} through GitHub MCP`;
  if (name === "submit_reprosmith_result") return "Submitting the ReproSmith proof contract";
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
  const boundedValue = clampText(value, maxHarnessTextBytes);
  const firstLine = redactHarnessText(boundedValue.replace(/```[\s\S]*?```/g, "").split("\n").map((line) => line.trim()).find(Boolean) ?? "");
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
  const boundedValue = clampText(value, maxHarnessTextBytes);
  return clampText(
    boundedValue
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
  const doneEvents = events.filter((event) => event.type === "turn.done").reverse();
  if (doneEvents.length === 0) {
    return undefined;
  }

  const streamedDeltaText = joinBoundedTexts(
    events
      .filter((event) => event.type === "model.message.delta")
      .flatMap((event) => resultOutputTexts(event.raw)),
    maxResultTextBytes
  );
  const outputTexts = [
    ...doneEvents.flatMap((event) => resultOutputTexts(event.raw)),
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
    const joinedOutput = outputTexts.join("");
    console.error("TrueForge completion had no parsable proof contract", JSON.stringify({
      outputCount: outputTexts.length,
      outputLengths: outputTexts.map((output) => output.length),
      joinedLength: joinedOutput.length,
      hasResultMarker: joinedOutput.includes("reprosmith.result"),
      hasCandidatePatch: joinedOutput.includes("candidatePatch"),
      hasKnownStatus: /\"status\"\s*:\s*\"(?:patch-ready|verified|not-reproduced|blocked|failed)\"/.test(joinedOutput),
      hasJsonObject: joinedOutput.includes("{")
    }));
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
    rootCauseSummary: clampText(
      typeof parsed.rootCauseSummary === "string" ? parsed.rootCauseSummary : summarizeCommentText(summary),
      520
    ),
    proposedFixSummary: clampText(
      typeof parsed.proposedFixSummary === "string"
        ? parsed.proposedFixSummary
        : candidatePatch
          ? summarizeCommentText(candidatePatch.body)
          : "No candidate fix was proposed because the proof was incomplete.",
      520
    ),
    ...(proof && Object.keys(proof).length > 0 ? { proof } : {}),
    ...(candidatePatch ? { candidatePatch } : {})
  };
}

async function hydratePatchEvidence(
  result: LiveProofResult,
  record: PersistedWebhookRunRecord,
  githubClient: GitHubRestClientLike | undefined
): Promise<LiveProofResult> {
  if (!result.candidatePatch || !githubClient || typeof githubClient.getFile !== "function") {
    return result;
  }

  const diffs: Array<{ path: string; before: string; after: string }> = [];
  for (const file of result.candidatePatch.files) {
    try {
      const source = await githubClient.getFile(
        record.run.issue.owner,
        record.run.issue.repo,
        file.path,
        result.candidatePatch.baseBranch
      );
      const before = source.encoding.toLowerCase() === "base64"
        ? Buffer.from(source.content.replace(/\s+/g, ""), "base64").toString("utf8")
        : source.content;
      diffs.push({ path: file.path, before, after: file.content });
    } catch (error) {
      console.warn(`Could not load base content for ${file.path}`, error);
    }
  }

  let baseSha: string | undefined;
  if (typeof githubClient.getBranch === "function") {
    try {
      baseSha = (await githubClient.getBranch(
        record.run.issue.owner,
        record.run.issue.repo,
        result.candidatePatch.baseBranch
      )).commit.sha;
    } catch {
      baseSha = undefined;
    }
  }

  return {
    ...result,
    ...(baseSha ? { baseSha } : {}),
    ...(diffs.length > 0 ? { patchDiff: diffs } : {})
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

  return candidates.map((candidate) => clampText(contentText(candidate), maxResultTextBytes)).filter((text) => text.length > 0);
}

function joinBoundedTexts(values: string[], maxBytes: number): string {
  let result = "";
  for (const value of values) {
    const remaining = maxBytes - Buffer.byteLength(result, "utf8");
    if (remaining <= 0) break;
    result += clampText(value, remaining);
  }
  return result;
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
    if (value.kind === "reprosmith.result" || isRecord(value.candidatePatch) || isCandidatePatchObject(value)) {
      return JSON.stringify(value);
    }
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
        if (isRecord(part.function)) return contentText(part.function.arguments);
      }
      return "";
    })
    .join("");
}

function parseResultJson(text: string): Record<string, unknown> | undefined {
  const candidates = balancedJsonObjects(text);
  for (const candidate of candidates) {
    try {
      const parsed = JSON.parse(candidate.trim()) as unknown;
      if (!isRecord(parsed)) continue;
      if (isReproSmithResultContract(parsed)) return parsed;
    } catch {
      // Try the next bounded candidate.
    }
  }
  return undefined;
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

function isReproSmithResultContract(value: Record<string, unknown>): boolean {
  const proof = isRecord(value.proof) ? value.proof : undefined;
  if (
    value.kind !== "reprosmith.result" ||
    !parseLiveResultStatus(value.status) ||
    typeof value.summary !== "string" ||
    !proof ||
    !["before", "after", "regressions", "attempts"].every((key) => typeof proof[key] === "string") ||
    !("candidatePatch" in value)
  ) {
    return false;
  }

  return value.candidatePatch === null || (isRecord(value.candidatePatch) && isCandidatePatchObject(value.candidatePatch));
}

function clampText(value: string, maxBytes: number): string {
  if (value.length <= maxBytes && Buffer.byteLength(value, "utf8") <= maxBytes) return value;
  const prefix = value.slice(0, maxBytes);
  if (Buffer.byteLength(prefix, "utf8") <= maxBytes) return prefix;
  return Buffer.from(prefix, "utf8").subarray(0, maxBytes).toString("utf8");
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
  if (webhook.action === "labeled") {
    return webhook.label?.name === triggerLabel();
  }
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
    authToken: mcpAuthToken,
    readOnly: true
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
