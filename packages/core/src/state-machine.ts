import type { GitHubIssueRef, ReproRun, RunEvent, RunStatus } from "./types.js";

const allowedTransitions: Record<RunStatus, RunStatus[]> = {
  received: ["security-review"],
  "security-review": ["triaging", "rejected"],
  rejected: [],
  triaging: ["needs-info", "environment-building"],
  "needs-info": [],
  "environment-building": ["reproducing", "environment-failed"],
  "environment-failed": [],
  reproducing: ["verified", "flaky", "not-reproduced"],
  "not-reproduced": [],
  flaky: [],
  verified: ["minimizing"],
  minimizing: ["fixing"],
  fixing: ["validating", "fix-failed"],
  validating: ["patch-ready", "fix-failed"],
  "fix-failed": [],
  "patch-ready": ["awaiting-approval"],
  "awaiting-approval": ["approved", "rejected"],
  approved: ["pr-created"],
  "pr-created": []
};

export function createRun(id: string, issue: GitHubIssueRef, now = new Date()): ReproRun {
  const timestamp = now.toISOString();
  return {
    id,
    issue,
    status: "received",
    createdAt: timestamp,
    updatedAt: timestamp,
    events: [
      {
        id: `${id}:received`,
        runId: id,
        at: timestamp,
        status: "received",
        message: "GitHub issue received"
      }
    ]
  };
}

export function canTransition(from: RunStatus, to: RunStatus): boolean {
  return allowedTransitions[from].includes(to);
}

export function transitionRun(
  run: ReproRun,
  nextStatus: RunStatus,
  message: string,
  options: { now?: Date; evidence?: Record<string, unknown> } = {}
): ReproRun {
  if (!canTransition(run.status, nextStatus)) {
    throw new Error(`Invalid ReproSmith transition: ${run.status} -> ${nextStatus}`);
  }

  const timestamp = (options.now ?? new Date()).toISOString();
  const event: RunEvent = {
    id: `${run.id}:${run.events.length + 1}:${nextStatus}`,
    runId: run.id,
    at: timestamp,
    status: nextStatus,
    message,
    ...(options.evidence ? { evidence: options.evidence } : {})
  };

  return {
    ...run,
    status: nextStatus,
    updatedAt: timestamp,
    events: [...run.events, event]
  };
}
