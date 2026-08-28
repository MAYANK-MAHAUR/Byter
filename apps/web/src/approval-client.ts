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
  const response = await fetch("/api/approvals", {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify(input)
  });
  if (!response.ok) {
    throw new Error(`Approval API returned ${response.status}`);
  }

  const submission = (await response.json()) as ApprovalSubmission;
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
