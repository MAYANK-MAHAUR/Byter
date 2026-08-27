import type { RunStatus } from "@reprosmith/core";
import type { ApprovalActionId } from "./data";

export interface ApprovalSubmission {
  id: string;
  runId: string;
  actionId: ApprovalActionId;
  resultStatus: RunStatus;
  message: string;
  savedAt: string;
}

const storagePrefix = "reprosmith:approval:";

export async function submitApprovalAction(input: {
  runId: string;
  actionId: ApprovalActionId;
  patchHash: string;
}): Promise<ApprovalSubmission> {
  await new Promise((resolve) => setTimeout(resolve, 240));

  const submission: ApprovalSubmission = {
    id: `${input.runId}:${input.actionId}:${input.patchHash}`,
    runId: input.runId,
    actionId: input.actionId,
    resultStatus: resultStatusFor(input.actionId),
    message: messageFor(input.actionId),
    savedAt: new Date().toISOString()
  };

  window.localStorage.setItem(`${storagePrefix}${input.runId}`, JSON.stringify(submission));
  return submission;
}

export function readApprovalSubmission(runId: string): ApprovalSubmission | undefined {
  const raw = window.localStorage.getItem(`${storagePrefix}${runId}`);
  if (!raw) {
    return undefined;
  }

  try {
    return JSON.parse(raw) as ApprovalSubmission;
  } catch {
    window.localStorage.removeItem(`${storagePrefix}${runId}`);
    return undefined;
  }
}

function resultStatusFor(actionId: ApprovalActionId): RunStatus {
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
    return "PR write approval saved";
  }

  if (actionId === "reject-run") {
    return "Run rejection saved";
  }

  return "Diff review request saved";
}
