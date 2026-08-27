import { describe, expect, it, vi } from "vitest";
import { ReproSmithTrueForgeRuntime, buildInitialUserMessage, buildReproSmithAgentSpec } from "../src/index.js";

const config = {
  baseUrl: "https://trueforge.example",
  token: "token",
  modelName: "glm-5.3",
  modelProvider: "agentrouter"
};

describe("ReproSmith TrueForge runtime", () => {
  it("builds an inline agent spec with sandbox and subagents enabled", () => {
    const spec = buildReproSmithAgentSpec(config);

    expect(spec.model.name).toBe("agentrouter/glm-5.3");
    expect(spec.config.sandbox.enabled).toBe(true);
    expect(spec.config.dynamicSubAgents.enabled).toBe(true);
    expect(spec.mcpServers).toEqual([{ name: "reprosmith-github" }]);
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
  });

  it("creates a session and first turn through the TrueForge SDK shape", async () => {
    const client = {
      sessions: {
        create: vi.fn().mockResolvedValue({ id: "session_1", title: null }),
        createTurn: vi.fn().mockResolvedValue({
          id: "turn_1",
          sessionId: "session_1",
          state: { status: "running" }
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
});
