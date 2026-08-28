import { createHash } from "node:crypto";
import { createReadStream } from "node:fs";
import { appendFile, mkdir, readFile, stat, writeFile } from "node:fs/promises";
import { createServer, type IncomingMessage, type Server, type ServerResponse } from "node:http";
import { dirname, extname, join, resolve } from "node:path";
import { fileURLToPath } from "node:url";
import { createRun, scanIssueText, transitionRun } from "@reprosmith/core";
import { runDemo, type DemoRunSummary } from "@reprosmith/demo-runner";
import { parseIssueWebhook, verifyGitHubWebhook } from "@reprosmith/github";

type ApprovalActionId = "approve-pr" | "request-diff" | "reject-run";
const maxRequestBodyBytes = 64 * 1024;
const demoCacheTtlMs = 5_000;
let demoCache: { createdAt: number; summary: DemoRunSummary } | undefined;
let demoInFlight: Promise<DemoRunSummary> | undefined;

export interface ReproSmithServerOptions {
  staticDir?: string;
  dataDir?: string;
}

export function createReproSmithServer(options: ReproSmithServerOptions = {}): Server {
  const staticDir = resolve(options.staticDir ?? process.env.STATIC_DIR ?? defaultStaticDir());
  const dataDir = options.dataDir ?? process.env.DATA_DIR;

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

      if (url.pathname === "/api/approvals") {
        await handleApproval(request, response, dataDir ? resolve(dataDir) : undefined);
        return;
      }

      if (url.pathname === "/api/github/webhook") {
        await handleGitHubWebhook(request, response, dataDir ? resolve(dataDir) : undefined);
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
  dataDir: string | undefined
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
  if (!isValidDeliveryId(deliveryId)) {
    throw new HttpError(400, "Invalid GitHub webhook headers");
  }

  if (!(await claimDelivery(dataDir, deliveryId))) {
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
    throw new HttpError(400, "Invalid GitHub webhook payload");
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

  const record = {
    receivedAt: new Date().toISOString(),
    deliveryId,
    repository: webhook.repository.full_name,
    issueTitle: webhook.issue.title,
    issueBody: webhook.issue.body ?? "",
    run,
    scan
  };
  await mkdir(dataDir, { recursive: true });
  await appendFile(join(dataDir, "webhook-runs.jsonl"), `${JSON.stringify(record)}\n`, "utf8");

  sendJson(response, 202, record);
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
    throw new HttpError(400, "Invalid JSON payload");
  }

  if (!parsed || typeof parsed !== "object" || Array.isArray(parsed)) {
    throw new HttpError(400, "Invalid request payload");
  }

  return parsed as Record<string, unknown>;
}

async function readText(request: IncomingMessage): Promise<string> {
  const contentLength = headerValue(request, "content-length");
  if (contentLength) {
    const declaredBytes = Number(contentLength);
    if (!Number.isSafeInteger(declaredBytes) || declaredBytes < 0) {
      throw new HttpError(400, "Invalid request headers");
    }

    if (declaredBytes > maxRequestBodyBytes) {
      throw new HttpError(413, "Request body too large");
    }
  }

  const chunks: Buffer[] = [];
  let bytes = 0;
  for await (const chunk of request) {
    const buffer = Buffer.isBuffer(chunk) ? chunk : Buffer.from(chunk);
    bytes += buffer.byteLength;
    if (bytes > maxRequestBodyBytes) {
      chunks.length = 0;
      request.destroy();
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
    throw new HttpError(400, "Invalid request payload");
  }

  return value;
}

function expectApprovalAction(value: unknown): ApprovalActionId {
  if (value === "approve-pr" || value === "request-diff" || value === "reject-run") {
    return value;
  }

  throw new HttpError(400, "Invalid request payload");
}

async function claimDelivery(dataDir: string, deliveryId: string): Promise<boolean> {
  const deliveryDir = join(dataDir, "webhook-deliveries");
  await mkdir(deliveryDir, { recursive: true });

  try {
    await writeFile(
      join(deliveryDir, `${createHash("sha256").update(deliveryId).digest("hex")}.json`),
      `${JSON.stringify({ deliveryId, claimedAt: new Date().toISOString() })}\n`,
      { encoding: "utf8", flag: "wx" }
    );
    return true;
  } catch (error) {
    if (!isFileAlreadyExistsError(error)) {
      throw error;
    }

    return false;
  }
}

function isValidDeliveryId(value: string | undefined): value is string {
  return typeof value === "string" && /^[A-Za-z0-9-]{1,100}$/.test(value);
}

function isFileAlreadyExistsError(error: unknown): boolean {
  return typeof error === "object" && error !== null && "code" in error && error.code === "EEXIST";
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

function defaultStaticDir(): string {
  return resolve(dirname(fileURLToPath(import.meta.url)), "../../web/dist");
}
