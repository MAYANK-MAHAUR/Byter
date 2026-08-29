import { TrueForge } from "@truefoundry/trueforge-sdk";
import {
  buildInitialUserMessage,
  buildProofContractRecoveryMessage,
  buildReproSmithAgentSpec
} from "./reprosmith-agent.js";
import type {
  StartReproSmithSessionInput,
  StartReproSmithSessionResult,
  TrueForgeClientLike,
  TrueForgePartialSessionFailureDetails,
  TrueForgeRuntimeConfig,
  TrueForgeRuntimeEvent,
  TrueForgeRuntimeEventListener,
  TrueForgeSession,
  TrueForgeTurn
} from "./types.js";

export class TrueForgeInitialTurnError extends Error {
  readonly details: TrueForgePartialSessionFailureDetails;

  constructor(details: TrueForgePartialSessionFailureDetails) {
    super(`TrueForge initial turn failed for created session ${details.session.id}`);
    this.name = "TrueForgeInitialTurnError";
    this.details = details;
  }
}

export class ReproSmithTrueForgeRuntime {
  private readonly client: TrueForgeClientLike;
  private readonly config: TrueForgeRuntimeConfig;

  constructor(config: TrueForgeRuntimeConfig, client?: TrueForgeClientLike) {
    this.config = config;
    this.client =
      client ??
      (new TrueForge({
        baseUrl: config.baseUrl,
        ...(config.token ? { token: config.token } : {}),
        headers: {
          "User-Agent": "CLINE"
        }
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

    let turn: TrueForgeTurn;
    try {
      turn = normalizeTurn(
        await this.client.sessions.createTurn(session.id, {
          input: [
            {
              type: "user.message",
              content: buildInitialUserMessage(input)
            }
          ]
        })
      );
    } catch (cause) {
      throw await this.handleInitialTurnFailure(session, cause);
    }

    return { session, turn };
  }

  async listSessionEvents(sessionId: string): Promise<TrueForgeRuntimeEvent[]> {
    const response = await this.client.sessions.listEvents(sessionId);
    const data = isRecord(response) && Array.isArray(response.data) ? response.data : [];
    return data.map(normalizeEvent);
  }

  async requestProofContract(sessionId: string): Promise<TrueForgeTurn> {
    return normalizeTurn(
      await this.client.sessions.createTurn(sessionId, {
        input: [
          {
            type: "user.message",
            content: buildProofContractRecoveryMessage()
          }
        ]
      })
    );
  }

  async subscribeToTurn(
    sessionId: string,
    turnId: string,
    onEvent?: TrueForgeRuntimeEventListener
  ): Promise<TrueForgeRuntimeEvent[]> {
    if (!this.client.sessions.subscribeToTurn) {
      throw new Error("TrueForge SDK does not expose turn subscription");
    }

    const stream = await this.client.sessions.subscribeToTurn(sessionId, turnId);
    const events: TrueForgeRuntimeEvent[] = [];
    for await (const event of stream) {
      const normalized = normalizeEvent(event);
      events.push(normalized);
      await onEvent?.(normalized);
    }

    return events;
  }

  private async handleInitialTurnFailure(session: TrueForgeSession, cause: unknown): Promise<TrueForgeInitialTurnError> {
    if (!this.client.sessions.delete) {
      return new TrueForgeInitialTurnError({
        session,
        cause,
        cleanupAttempted: false,
        cleanupSucceeded: false
      });
    }

    try {
      await this.client.sessions.delete(session.id);
      return new TrueForgeInitialTurnError({
        session,
        cause,
        cleanupAttempted: true,
        cleanupSucceeded: true
      });
    } catch (cleanupError) {
      return new TrueForgeInitialTurnError({
        session,
        cause,
        cleanupAttempted: true,
        cleanupSucceeded: false,
        cleanupError
      });
    }
  }
}

function normalizeSession(value: unknown): TrueForgeSession {
  const session = unwrapData(value);
  if (!isRecord(session) || typeof session.id !== "string") {
    throw new Error("TrueForge session response did not include an id");
  }

  return {
    id: session.id,
    title: typeof session.title === "string" ? session.title : null
  };
}

function normalizeTurn(value: unknown): TrueForgeTurn {
  const turn = unwrapData(value);
  if (!isRecord(turn) || typeof turn.id !== "string" || typeof turn.sessionId !== "string") {
    throw new Error("TrueForge turn response did not include ids");
  }

  return {
    id: turn.id,
    sessionId: turn.sessionId,
    status: turnStatus(turn.state)
  };
}

function unwrapData(value: unknown): unknown {
  return isRecord(value) && "data" in value ? value.data : value;
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
