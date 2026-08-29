import { createHash } from "node:crypto";
import { createReadStream } from "node:fs";
import { appendFile, mkdir, open, readFile, stat } from "node:fs/promises";
import { createServer, type IncomingMessage, type Server, type ServerResponse } from "node:http";
import { dirname, extname, join, resolve } from "node:path";
import { fileURLToPath } from "node:url";
import { ReproSmithTrueForgeRuntime } from "@reprosmith/agent";
import type {
  StartReproSmithSessionInput,
  StartReproSmithSessionResult,
  TrueForgeRuntimeEvent
} from "@reprosmith/agent";
import { createRun, scanIssueText, transitionRun } from "@reprosmith/core";
import { runDemo, type DemoRunSummary } from "@reprosmith/demo-runner";
import { parseIssueWebhook, verifyGitHubWebhook } from "@reprosmith/github";

type ApprovalActionId = "approve-pr" | "request-diff" | "reject-run";
const maxRequestBodyBytes = 64 * 1024;
const maxLatestRunReadBytes = 256 * 1024;
const demoCacheTtlMs = 5_000;
let demoCache: { createdAt: number; summary: DemoRunSummary } | undefined;
let demoInFlight: Promise<DemoRunSummary> | undefined;

export interface ReproSmithServerOptions {
  staticDir?: string;
  dataDir?: string;
  trueForgeRuntime?: ReproSmithSessionStarter;
}

interface ReproSmithSessionStarter {
  startSession(input: StartReproSmithSessionInput): Promise<StartReproSmithSessionResult>;
  subscribeToTurn?(sessionId: string, turnId: string): Promise<TrueForgeRuntimeEvent[]>;
}

interface PersistedWebhookRunRecord {
  receivedAt: string;
  deliveryId: string;
  repository: string;
  issueTitle: string;
  issueBody: string;
  run: ReturnType<typeof createRun>;
  scan: ReturnType<typeof scanIssueText>;
  trueForge: {
    status: string;
    reason?: string;
    error?: string;
    session?: { id: string; title: string | null };
    turn?: { id: string; status: string };
    events?: Array<{ sequenceNumber?: number; type: string }>;
  };
}

export function createReproSmithServer(options: ReproSmithServerOptions = {}): Server {
  const staticDir = resolve(options.staticDir ?? process.env.STATIC_DIR ?? defaultStaticDir());
  const dataDir = options.dataDir ?? process.env.DATA_DIR;
  const trueForgeRuntime = options.trueForgeRuntime ?? trueForgeRuntimeFromEnv();

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
        await handleLatestRun(request, response, dataDir ? resolve(dataDir) : undefined);
        return;
      }

      if (url.pathname === "/api/approvals") {
        await handleApproval(request, response, dataDir ? resolve(dataDir) : undefined);
        return;
      }

      if (url.pathname === "/api/github/webhook") {
        await handleGitHubWebhook(request, response, dataDir ? resolve(dataDir) : undefined, trueForgeRuntime);
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
  trueForgeRuntime: ReproSmithSessionStarter | undefined
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
  if (!["opened", "edited", "reopened"].includes(webhook.action)) {
    sendJson(response, 202, { ignored: true, reason: `Unsupported issue action: ${webhook.action}` });
    return;
  }

  const issueText = [webhook.issue.title, webhook.issue.body ?? ""].join("\n");
  const scan = scanIssueText(issueText);
  let run = createRun(`github-${webhook.repository.owner.login}-${webhook.repository.name}-${webhook.issue.number}`, {
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
    issueTitle: webhook.issue.title,
    issueBody: webhook.issue.body ?? "",
    run,
    scan,
    trueForge: orchestration.trueForge
  };
  await mkdir(dataDir, { recursive: true });
  await appendFile(join(dataDir, "webhook-runs.jsonl"), `${JSON.stringify(record)}\n`, "utf8");
  if (orchestration.trueForge.status === "started" && trueForgeRuntime?.subscribeToTurn) {
    void monitorTrueForgeTurn(dataDir, record, trueForgeRuntime);
  }

  sendJson(response, 202, record);
}

async function handleLatestRun(
  request: IncomingMessage,
  response: ServerResponse,
  dataDir: string | undefined
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

  sendJson(response, 200, latest);
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
        turn: result.turn
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
  dataDir: string | undefined
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
  const latestRun = await getDemoRun();
  if (latestRun.run.id !== runId || latestRun.candidatePatch.hash !== patchHash) {
    sendJson(response, 409, { error: "Approval payload does not match the current run" });
    return;
  }

  const savedAt = new Date().toISOString();
  const receipt = {
    id: createHash("sha256").update(`${runId}:${actionId}:${patchHash}:${savedAt}`).digest("hex").slice(0, 16),
    runId,
    actionId,
    actor: "token-authenticated maintainer",
    approvedPayloadHash: createHash("sha256").update(`${runId}:${actionId}:${patchHash}`).digest("hex"),
    patchHash,
    resultStatus: resultStatusFor(actionId),
    message: messageFor(actionId),
    savedAt
  };

  await mkdir(dataDir, { recursive: true });
  await appendFile(join(dataDir, "approvals.jsonl"), `${JSON.stringify(receipt)}\n`, "utf8");

  sendJson(response, 200, receipt);
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
    for (let index = lines.length - 1; index >= 0; index -= 1) {
      try {
        return JSON.parse(lines[index]) as unknown;
      } catch {
        continue;
      }
    }

    return undefined;
  } finally {
    await file.close();
  }
}

async function monitorTrueForgeTurn(
  dataDir: string,
  record: PersistedWebhookRunRecord,
  trueForgeRuntime: ReproSmithSessionStarter
): Promise<void> {
  if (!record.trueForge.session?.id || !record.trueForge.turn?.id || !trueForgeRuntime.subscribeToTurn) {
    return;
  }

  try {
    const events = await trueForgeRuntime.subscribeToTurn(record.trueForge.session.id, record.trueForge.turn.id);
    const eventMetadata = events.slice(-100).map((event) => ({
      ...(event.sequenceNumber !== undefined ? { sequenceNumber: event.sequenceNumber } : {}),
      type: event.type
    }));
    await appendFile(
      join(dataDir, "webhook-runs.jsonl"),
      `${JSON.stringify({
        ...record,
        trueForge: {
          ...record.trueForge,
          status: "completed",
          events: eventMetadata
        }
      })}\n`,
      "utf8"
    );
  } catch (error) {
    console.error("TrueForge turn subscription failed", error);
    let failedRun = record.run;
    if (failedRun.status === "environment-building") {
      failedRun = transitionRun(failedRun, "failed", "TrueForge turn monitoring failed");
    }
    await appendFile(
      join(dataDir, "webhook-runs.jsonl"),
      `${JSON.stringify({
        ...record,
        run: failedRun,
        trueForge: {
          ...record.trueForge,
          status: "failed",
          error: "TrueForge turn monitoring failed"
        }
      })}\n`,
      "utf8"
    );
  }
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
    modelProvider: process.env.MODEL_PROVIDER ?? "agentrouter"
  });
}

function defaultStaticDir(): string {
  return resolve(dirname(fileURLToPath(import.meta.url)), "../../web/dist");
}
