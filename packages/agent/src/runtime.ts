import { TrueForge } from "@truefoundry/trueforge-sdk";
import { buildInitialUserMessage, buildReproSmithAgentSpec } from "./reprosmith-agent.js";
import type {
  StartReproSmithSessionInput,
  StartReproSmithSessionResult,
  TrueForgeClientLike,
  TrueForgeRuntimeConfig,
  TrueForgeRuntimeEvent,
  TrueForgeSession,
  TrueForgeTurn
} from "./types.js";

export class ReproSmithTrueForgeRuntime {
  private readonly client: TrueForgeClientLike;
  private readonly config: TrueForgeRuntimeConfig;

  constructor(config: TrueForgeRuntimeConfig, client?: TrueForgeClientLike) {
    this.config = config;
    this.client =
      client ??
      (new TrueForge({
        baseUrl: config.baseUrl,
        ...(config.token ? { token: config.token } : {})
      }) as unknown as TrueForgeClientLike);
  }

  async startSession(input: StartReproSmithSessionInput): Promise<StartReproSmithSessionResult> {
    const session = normalizeSession(
      await this.client.sessions.create({
        agent: {
          spec: buildReproSmithAgentSpec(this.config)
        }
      })
    );

    const turn = normalizeTurn(
      await this.client.sessions.createTurn(session.id, {
        input: [
          {
            type: "user.message",
            content: buildInitialUserMessage(input)
          }
        ]
      })
    );

    return { session, turn };
  }

  async listSessionEvents(sessionId: string): Promise<TrueForgeRuntimeEvent[]> {
    const response = await this.client.sessions.listEvents(sessionId);
    const data = isRecord(response) && Array.isArray(response.data) ? response.data : [];
    return data.map(normalizeEvent);
  }

  async subscribeToTurn(sessionId: string, turnId: string): Promise<TrueForgeRuntimeEvent[]> {
    if (!this.client.sessions.subscribeToTurn) {
      throw new Error("TrueForge SDK does not expose turn subscription");
    }

    const stream = await this.client.sessions.subscribeToTurn(sessionId, turnId);
    const events: TrueForgeRuntimeEvent[] = [];
    for await (const event of stream) {
      events.push(normalizeEvent(event));
    }

    return events;
  }
}

function normalizeSession(value: unknown): TrueForgeSession {
  if (!isRecord(value) || typeof value.id !== "string") {
    throw new Error("TrueForge session response did not include an id");
  }

  return {
    id: value.id,
    title: typeof value.title === "string" ? value.title : null
  };
}

function normalizeTurn(value: unknown): TrueForgeTurn {
  if (!isRecord(value) || typeof value.id !== "string" || typeof value.sessionId !== "string") {
    throw new Error("TrueForge turn response did not include ids");
  }

  return {
    id: value.id,
    sessionId: value.sessionId,
    status: turnStatus(value.state)
  };
}

function normalizeEvent(value: unknown): TrueForgeRuntimeEvent {
  const event = isRecord(value) && isRecord(value.event) ? value.event : value;
  const sequenceNumber =
    isRecord(value) && typeof value.sequenceNumber === "number" ? value.sequenceNumber : undefined;
  const type = isRecord(event) && typeof event.type === "string" ? event.type : "unknown";

  return {
    ...(sequenceNumber !== undefined ? { sequenceNumber } : {}),
    type,
    raw: value
  };
}

function turnStatus(state: unknown): string {
  return isRecord(state) && typeof state.status === "string" ? state.status : "unknown";
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null;
}
