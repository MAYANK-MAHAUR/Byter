import { createHash } from "node:crypto";
import type { IncomingMessage, ServerResponse } from "node:http";
import { defineConfig } from "vite";
import type { Plugin } from "vite";
import react from "@vitejs/plugin-react";

type ApprovalActionId = "approve-pr" | "request-diff" | "reject-run";

export default defineConfig({
  plugins: [react(), reproSmithApi()],
  server: {
    host: "127.0.0.1",
    port: 5173
  }
});

function reproSmithApi(): Plugin {
  return {
    name: "reprosmith-local-api",
    configureServer(server) {
      server.middlewares.use(async (request, response, next) => {
        const pathname = new URL(request.url ?? "/", "http://127.0.0.1").pathname;
        if (pathname === "/api/demo-run") {
          await handleDemoRun(request, response);
          return;
        }

        if (pathname === "/api/approvals") {
          await handleApproval(request, response);
          return;
        }

        next();
      });
    }
  };
}

async function handleDemoRun(request: IncomingMessage, response: ServerResponse): Promise<void> {
  if (request.method !== "GET") {
    sendJson(response, 405, { error: "Method not allowed" });
    return;
  }

  try {
    const { runDemo } = await import("@reprosmith/demo-runner");
    sendJson(response, 200, await runDemo());
  } catch (error) {
    sendJson(response, 500, { error: error instanceof Error ? error.message : "Demo run failed" });
  }
}

async function handleApproval(request: IncomingMessage, response: ServerResponse): Promise<void> {
  if (request.method !== "POST") {
    sendJson(response, 405, { error: "Method not allowed" });
    return;
  }

  try {
    const payload = await readJson(request);
    const actionId = expectApprovalAction(payload.actionId);
    const runId = expectString(payload.runId, "runId");
    const patchHash = expectString(payload.patchHash, "patchHash");
    const savedAt = new Date().toISOString();

    sendJson(response, 200, {
      id: createHash("sha256").update(`${runId}:${actionId}:${patchHash}:${savedAt}`).digest("hex").slice(0, 16),
      runId,
      actionId,
      resultStatus: resultStatusFor(actionId),
      message: messageFor(actionId),
      savedAt
    });
  } catch (error) {
    sendJson(response, 400, { error: error instanceof Error ? error.message : "Invalid approval payload" });
  }
}

async function readJson(request: IncomingMessage): Promise<Record<string, unknown>> {
  const chunks: Buffer[] = [];
  for await (const chunk of request) {
    chunks.push(Buffer.isBuffer(chunk) ? chunk : Buffer.from(chunk));
  }

  const parsed = JSON.parse(Buffer.concat(chunks).toString("utf8")) as unknown;
  if (!parsed || typeof parsed !== "object" || Array.isArray(parsed)) {
    throw new Error("Expected object payload");
  }

  return parsed as Record<string, unknown>;
}

function expectString(value: unknown, name: string): string {
  if (typeof value !== "string" || value.length === 0) {
    throw new Error(`Expected non-empty string: ${name}`);
  }

  return value;
}

function expectApprovalAction(value: unknown): ApprovalActionId {
  if (value === "approve-pr" || value === "request-diff" || value === "reject-run") {
    return value;
  }

  throw new Error("Expected valid approval action");
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
    return "PR write approval accepted by local API";
  }

  if (actionId === "reject-run") {
    return "Run rejection accepted by local API";
  }

  return "Diff review request accepted by local API";
}

function sendJson(response: ServerResponse, statusCode: number, body: unknown): void {
  response.statusCode = statusCode;
  response.setHeader("Content-Type", "application/json");
  response.end(JSON.stringify(body));
}
