import { mkdtemp, readFile, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { dirname, join } from "node:path";
import { AddressInfo } from "node:net";
import { fileURLToPath } from "node:url";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { createReproSmithServer } from "../src/server.js";
import { signWebhookPayload } from "@reprosmith/github";

describe("ReproSmith production server", () => {
  let baseUrl: string;
  let closeServer: () => Promise<void>;
  let dataDir: string;

  beforeEach(async () => {
    process.env.GITHUB_WEBHOOK_SECRET = "webhook-secret";
    process.env.APPROVAL_TOKEN = "approval-token";
    delete process.env.TRUEFORGE_URL;
    delete process.env.TRUEFORGE_API_KEY;
    const staticDir = await mkdtemp(join(tmpdir(), "reprosmith-static-"));
    dataDir = await mkdtemp(join(tmpdir(), "reprosmith-data-"));
    await writeFile(join(staticDir, "index.html"), "<main>ReproSmith</main>", "utf8");

    const server = createReproSmithServer({ staticDir, dataDir });
    await new Promise<void>((resolve) => server.listen(0, "127.0.0.1", resolve));
    const address = server.address() as AddressInfo;
    baseUrl = `http://127.0.0.1:${address.port}`;
    closeServer = () => new Promise((resolve, reject) => server.close((error) => (error ? reject(error) : resolve())));
  });

  afterEach(async () => {
    delete process.env.GITHUB_WEBHOOK_SECRET;
    delete process.env.APPROVAL_TOKEN;
    delete process.env.TRUEFORGE_URL;
    delete process.env.TRUEFORGE_API_KEY;
    await closeServer();
  });

  it("serves health and the built dashboard shell", async () => {
    await expect(fetch(`${baseUrl}/healthz`).then((response) => response.json())).resolves.toEqual({ ok: true });
    await expect(fetch(baseUrl).then((response) => response.text())).resolves.toContain("ReproSmith");
  });

  it("returns live demo data and persists approval receipts", async () => {
    const run = await fetch(`${baseUrl}/api/demo-run`).then((response) => response.json());
    expect(run.run.status).toBe("awaiting-approval");

    const approval = await fetch(`${baseUrl}/api/approvals`, {
      method: "POST",
      headers: { "Content-Type": "application/json", Authorization: "Bearer approval-token" },
      body: JSON.stringify({
        runId: run.run.id,
        actionId: "approve-pr",
        patchHash: run.candidatePatch.hash
      })
    }).then((response) => response.json());

    expect(approval.resultStatus).toBe("approved");
    await expect(readFile(join(dataDir, "approvals.jsonl"), "utf8")).resolves.toContain(approval.id);
  });

  it("rejects approval receipts without maintainer authentication", async () => {
    const response = await fetch(`${baseUrl}/api/approvals`, {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ runId: "demo-run", actionId: "approve-pr", patchHash: "ea26aee839ac" })
    });

    expect(response.status).toBe(401);
  });

  it("rejects approval receipts for non-current run payloads", async () => {
    const response = await fetch(`${baseUrl}/api/approvals`, {
      method: "POST",
      headers: { "Content-Type": "application/json", Authorization: "Bearer approval-token" },
      body: JSON.stringify({ runId: "wrong-run", actionId: "approve-pr", patchHash: "wrong-hash" })
    });

    expect(response.status).toBe(409);
  });

  it("verifies and records GitHub issue webhooks", async () => {
    const emptyLatest = await fetch(`${baseUrl}/api/runs/latest`);
    expect(emptyLatest.status).toBe(404);

    const payload = JSON.stringify({
      action: "opened",
      issue: {
        number: 17,
        title: "Parser crash",
        body: "Trailing escape crashes the parser.",
        html_url: "https://github.test/o/r/issues/17"
      },
      repository: {
        name: "r",
        full_name: "o/r",
        default_branch: "main",
        owner: { login: "o" }
      }
    });

    const response = await fetch(`${baseUrl}/api/github/webhook`, {
      method: "POST",
      headers: {
        "Content-Type": "application/json",
        "X-GitHub-Event": "issues",
        "X-GitHub-Delivery": "delivery-17",
        "X-Hub-Signature-256": signWebhookPayload(payload, "webhook-secret")
      },
      body: payload
    });
    const body = await response.json();

    expect(response.status).toBe(202);
    expect(body.run.status).toBe("triaging");
    expect(body.trueForge.status).toBe("not-configured");
    await expect(readFile(join(dataDir, "webhook-runs.jsonl"), "utf8")).resolves.toContain("Parser crash");

    const latest = await fetch(`${baseUrl}/api/runs/latest`).then((latestResponse) => latestResponse.json());
    expect(latest.deliveryId).toBe("delivery-17");
    expect(latest.run.id).toBe(body.run.id);
  });

  it("starts a TrueForge session for safe signed GitHub issue webhooks", async () => {
    const staticDir = await mkdtemp(join(tmpdir(), "reprosmith-static-"));
    const liveDataDir = await mkdtemp(join(tmpdir(), "reprosmith-data-"));
    await writeFile(join(staticDir, "index.html"), "<main>ReproSmith</main>", "utf8");
    const trueForgeRuntime = {
      startSession: vi.fn().mockResolvedValue({
        session: { id: "session-live-1", title: null },
        turn: { id: "turn-live-1", sessionId: "session-live-1", status: "running" }
      })
    };
    const server = createReproSmithServer({ staticDir, dataDir: liveDataDir, trueForgeRuntime });
    await new Promise<void>((resolve) => server.listen(0, "127.0.0.1", resolve));
    const address = server.address() as AddressInfo;
    const isolatedBaseUrl = `http://127.0.0.1:${address.port}`;
    const payload = JSON.stringify({
      action: "opened",
      issue: {
        number: 20,
        title: "Parser crash in production",
        body: "Trailing escape crashes the parser.",
        html_url: "https://github.test/o/r/issues/20"
      },
      repository: {
        name: "r",
        full_name: "o/r",
        default_branch: "main",
        owner: { login: "o" }
      }
    });

    try {
      const response = await fetch(`${isolatedBaseUrl}/api/github/webhook`, {
        method: "POST",
        headers: {
          "Content-Type": "application/json",
          "X-GitHub-Event": "issues",
          "X-GitHub-Delivery": "delivery-live-20",
          "X-Hub-Signature-256": signWebhookPayload(payload, "webhook-secret")
        },
        body: payload
      });
      const body = await response.json();

      expect(response.status).toBe(202);
      expect(trueForgeRuntime.startSession).toHaveBeenCalledWith({
        repository: "o/r",
        issueUrl: "https://github.test/o/r/issues/20",
        issueTitle: "Parser crash in production",
        issueBody: "Trailing escape crashes the parser."
      });
      expect(body.run.status).toBe("environment-building");
      expect(body.trueForge.status).toBe("started");
      expect(body.trueForge.session.id).toBe("session-live-1");
      await expect(readFile(join(liveDataDir, "webhook-runs.jsonl"), "utf8")).resolves.toContain("session-live-1");
    } finally {
      await new Promise<void>((resolve, reject) => server.close((error) => (error ? reject(error) : resolve())));
    }
  });

  it("deduplicates repeated GitHub delivery IDs", async () => {
    const payload = JSON.stringify({
      action: "opened",
      issue: {
        number: 18,
        title: "Parser crash again",
        body: "Trailing escape crashes the parser.",
        html_url: "https://github.test/o/r/issues/18"
      },
      repository: {
        name: "r",
        full_name: "o/r",
        default_branch: "main",
        owner: { login: "o" }
      }
    });
    const headers = {
      "Content-Type": "application/json",
      "X-GitHub-Event": "issues",
      "X-GitHub-Delivery": "delivery-18",
      "X-Hub-Signature-256": signWebhookPayload(payload, "webhook-secret")
    };

    const first = await fetch(`${baseUrl}/api/github/webhook`, { method: "POST", headers, body: payload });
    const second = await fetch(`${baseUrl}/api/github/webhook`, { method: "POST", headers, body: payload });
    const duplicate = await second.json();

    expect(first.status).toBe(202);
    expect(second.status).toBe(202);
    expect(duplicate).toEqual({ ignored: true, reason: "Duplicate GitHub delivery" });
  });

  it("rejects GitHub webhooks with invalid signatures", async () => {
    const response = await fetch(`${baseUrl}/api/github/webhook`, {
      method: "POST",
      headers: {
        "Content-Type": "application/json",
        "X-GitHub-Event": "issues",
        "X-GitHub-Delivery": "delivery-bad",
        "X-Hub-Signature-256": "sha256=bad"
      },
      body: "{}"
    });

    expect(response.status).toBe(403);
  });

  it("returns 400 for malformed signed GitHub issue payloads", async () => {
    const payload = "{}";
    const response = await fetch(`${baseUrl}/api/github/webhook`, {
      method: "POST",
      headers: {
        "Content-Type": "application/json",
        "X-GitHub-Event": "issues",
        "X-GitHub-Delivery": "delivery-malformed",
        "X-Hub-Signature-256": signWebhookPayload(payload, "webhook-secret")
      },
      body: payload
    });

    expect(response.status).toBe(400);
  });

  it("requires DATA_DIR before accepting persistent write endpoints", async () => {
    const staticDir = await mkdtemp(join(tmpdir(), "reprosmith-static-"));
    await writeFile(join(staticDir, "index.html"), "<main>ReproSmith</main>", "utf8");
    const server = createReproSmithServer({ staticDir });
    await new Promise<void>((resolve) => server.listen(0, "127.0.0.1", resolve));
    const address = server.address() as AddressInfo;
    const isolatedBaseUrl = `http://127.0.0.1:${address.port}`;
    const payload = JSON.stringify({
      action: "opened",
      issue: {
        number: 19,
        title: "Parser crash",
        body: "Trailing escape crashes the parser.",
        html_url: "https://github.test/o/r/issues/19"
      },
      repository: {
        name: "r",
        full_name: "o/r",
        default_branch: "main",
        owner: { login: "o" }
      }
    });

    try {
      const approval = await fetch(`${isolatedBaseUrl}/api/approvals`, {
        method: "POST",
        headers: { "Content-Type": "application/json", Authorization: "Bearer approval-token" },
        body: JSON.stringify({ runId: "demo-run", actionId: "approve-pr", patchHash: "ea26aee839ac" })
      });
      const webhook = await fetch(`${isolatedBaseUrl}/api/github/webhook`, {
        method: "POST",
        headers: {
          "Content-Type": "application/json",
          "X-GitHub-Event": "issues",
          "X-GitHub-Delivery": "delivery-no-data-dir",
          "X-Hub-Signature-256": signWebhookPayload(payload, "webhook-secret")
        },
        body: payload
      });

      expect(approval.status).toBe(503);
      expect(webhook.status).toBe(503);
    } finally {
      await new Promise<void>((resolve, reject) => server.close((error) => (error ? reject(error) : resolve())));
    }
  });

  it("returns client errors for malformed JSON and oversized bodies", async () => {
    const malformed = await fetch(`${baseUrl}/api/approvals`, {
      method: "POST",
      headers: { "Content-Type": "application/json", Authorization: "Bearer approval-token" },
      body: "{"
    });
    const oversized = await fetch(`${baseUrl}/api/approvals`, {
      method: "POST",
      headers: { "Content-Type": "application/json", Authorization: "Bearer approval-token" },
      body: JSON.stringify({ runId: "demo-run", actionId: "approve-pr", patchHash: "x".repeat(70_000) })
    });

    expect(malformed.status).toBe(400);
    expect(oversized.status).toBe(413);
  });

  it("serves the default built web directory from the package working directory", async () => {
    const packageDir = join(dirname(fileURLToPath(import.meta.url)), "..");
    const previousCwd = process.cwd();
    process.chdir(packageDir);
    try {
      const server = createReproSmithServer();
      await new Promise<void>((resolve) => server.listen(0, "127.0.0.1", resolve));
      const address = server.address() as AddressInfo;
      const response = await fetch(`http://127.0.0.1:${address.port}`);
      await new Promise<void>((resolve, reject) => server.close((error) => (error ? reject(error) : resolve())));

      expect(response.status).toBe(200);
      await expect(response.text()).resolves.toContain("id=\"root\"");
    } finally {
      process.chdir(previousCwd);
    }
  });
});
