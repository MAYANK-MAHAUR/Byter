import { describe, expect, it, vi } from "vitest";
import {
  ReproSmithTrueForgeRuntime,
  TrueForgeInitialTurnError,
  buildInitialUserMessage,
  buildProofContractRecoveryMessage,
  buildReproSmithAgentSpec
} from "../src/index.js";

const config = {
  baseUrl: "https://trueforge.example",
  token: "token",
  modelName: "glm-5.3",
  modelProvider: "agentrouter"
};

describe("ReproSmith TrueForge runtime", () => {
  it("sends the CLINE user agent required by the TrueForge deployment", () => {
    const runtime = new ReproSmithTrueForgeRuntime(config);
    const client = (runtime as unknown as { client: { _options: { headers: Record<string, string> } } }).client;

    expect(client._options.headers["user-agent"]).toBe("CLINE");
  });

  it("builds an inline agent spec with sandbox and subagents enabled", () => {
    const spec = buildReproSmithAgentSpec(config);

    expect(spec.model.name).toBe("agentrouter/glm-5.3");
    expect(spec.responseFormat).toMatchObject({
      type: "json_schema",
      jsonSchema: {
        name: "reprosmith_result",
        strict: true,
        schema: expect.objectContaining({
          required: expect.arrayContaining(["kind", "status", "summary", "proof"])
        })
      }
    });
    expect(spec.config.askUserQuestions.enabled).toBe(false);
    expect(spec.config.sandbox.enabled).toBe(true);
    expect(spec.config.dynamicSubAgents.enabled).toBe(true);
    expect(spec.mcpServers).toEqual([
      {
        name: "reprosmith-github",
        preload: true,
        enableTools: ["@read-only"],
        requireApprovalForTools: []
      }
    ]);
  });

  it("builds the initial issue analysis prompt", () => {
    const message = buildInitialUserMessage({
      issueUrl: "https://github.com/MAYANK-MAHAUR/Byter/issues/1",
      issueTitle: "Trailing escape crash",
      issueBody: "Tokenizer throws on a single backslash.",
      repository: "MAYANK-MAHAUR/Byter",
      baseSha: "abc123"
    });

    expect(message).toContain("Repository: MAYANK-MAHAUR/Byter");
    expect(message).toContain("Base SHA: abc123");
    expect(message).toContain("Require the same target failure 3/3");
    expect(message).toContain("node-v22.14.0-linux-x64.tar.xz");
  });

  it("creates a session and first turn through the TrueForge SDK shape", async () => {
    const client = {
      sessions: {
        create: vi.fn().mockResolvedValue({ data: { id: "session_1", title: null } }),
        createTurn: vi.fn().mockResolvedValue({
          data: {
            id: "turn_1",
            sessionId: "session_1",
            state: { status: "running" }
          }
        }),
        listEvents: vi.fn()
      }
    };
    const runtime = new ReproSmithTrueForgeRuntime(config, client);

    const result = await runtime.startSession({
      issueUrl: "https://github.com/MAYANK-MAHAUR/Byter/issues/1",
      issueTitle: "Bug",
      issueBody: "Breaks",
      repository: "MAYANK-MAHAUR/Byter"
    });

    expect(result.session.id).toBe("session_1");
    expect(result.turn.status).toBe("running");
    expect(client.sessions.create).toHaveBeenCalledWith({
      agent: { spec: expect.objectContaining({ model: { name: "agentrouter/glm-5.3" } }) }
    });
    expect(client.sessions.createTurn).toHaveBeenCalledWith(
      "session_1",
      expect.objectContaining({
        input: [expect.objectContaining({ type: "user.message" })]
      })
    );
  });

  it("requests a bounded proof contract recovery turn", async () => {
    const client = {
      sessions: {
        create: vi.fn(),
        createTurn: vi.fn().mockResolvedValue({
          data: {
            id: "turn_recovery",
            sessionId: "session_1",
            state: { status: "running" }
          }
        }),
        listEvents: vi.fn()
      }
    };
    const runtime = new ReproSmithTrueForgeRuntime(config, client);

    await expect(runtime.requestProofContract("session_1")).resolves.toEqual({
      id: "turn_recovery",
      sessionId: "session_1",
      status: "running"
    });
    expect(buildProofContractRecoveryMessage()).toContain("Do not call tools");
    expect(client.sessions.createTurn).toHaveBeenCalledWith(
      "session_1",
      expect.objectContaining({
        input: [expect.objectContaining({
          type: "user.message",
          content: expect.stringContaining("valid reprosmith.result object")
        })]
      })
    );
  });

  it("normalizes stored session events", async () => {
    const client = {
      sessions: {
        create: vi.fn(),
        createTurn: vi.fn(),
        listEvents: vi.fn().mockResolvedValue({
          data: [{ sequenceNumber: 2, event: { type: "sandbox.created" } }]
        })
      }
    };
    const runtime = new ReproSmithTrueForgeRuntime(config, client);

    await expect(runtime.listSessionEvents("session_1")).resolves.toEqual([
      { sequenceNumber: 2, type: "sandbox.created", raw: { sequenceNumber: 2, event: { type: "sandbox.created" } } }
    ]);
  });

  it("deletes the created session if initial turn creation fails", async () => {
    const client = {
      sessions: {
        create: vi.fn().mockResolvedValue({ id: "session_1", title: null }),
        createTurn: vi.fn().mockRejectedValue(new Error("turn failed")),
        delete: vi.fn().mockResolvedValue(undefined),
        listEvents: vi.fn()
      }
    };
    const runtime = new ReproSmithTrueForgeRuntime(config, client);

    await expect(
      runtime.startSession({
        issueUrl: "https://github.com/MAYANK-MAHAUR/Byter/issues/1",
        issueTitle: "Bug",
        issueBody: "Breaks",
        repository: "MAYANK-MAHAUR/Byter"
      })
    ).rejects.toMatchObject({
      name: "TrueForgeInitialTurnError",
      details: {
        session: { id: "session_1", title: null },
        cleanupAttempted: true,
        cleanupSucceeded: true
      }
    });

    expect(client.sessions.delete).toHaveBeenCalledWith("session_1");
  });

  it("exposes the created session when cleanup is unavailable", async () => {
    const client = {
      sessions: {
        create: vi.fn().mockResolvedValue({ id: "session_1", title: "Recovered" }),
        createTurn: vi.fn().mockRejectedValue(new Error("turn failed")),
        listEvents: vi.fn()
      }
    };
    const runtime = new ReproSmithTrueForgeRuntime(config, client);

    try {
      await runtime.startSession({
        issueUrl: "https://github.com/MAYANK-MAHAUR/Byter/issues/1",
        issueTitle: "Bug",
        issueBody: "Breaks",
        repository: "MAYANK-MAHAUR/Byter"
      });
      throw new Error("Expected startSession to fail");
    } catch (error) {
      expect(error).toBeInstanceOf(TrueForgeInitialTurnError);
      expect((error as TrueForgeInitialTurnError).details).toMatchObject({
        session: { id: "session_1", title: "Recovered" },
        cleanupAttempted: false,
        cleanupSucceeded: false
      });
    }
  });
});
