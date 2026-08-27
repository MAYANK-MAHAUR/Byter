import type { GitHubRestClient } from "@reprosmith/github";

export interface ApprovalContext {
  approved: boolean;
  payloadHash?: string;
  expectedPayloadHash?: string;
}

export type GitHubMcpToolName = "read_issue" | "read_file" | "add_verified_label" | "comment_on_issue";

export interface GitHubMcpToolCall {
  name: GitHubMcpToolName;
  arguments: Record<string, unknown>;
  approval?: ApprovalContext;
}

export interface GitHubMcpToolResult {
  content: Array<{ type: "text"; text: string }>;
}

export interface GitHubMcpServerOptions {
  client: GitHubRestClient;
}

export function listGitHubTools(): Array<{ name: GitHubMcpToolName; description: string; requiresApproval: boolean }> {
  return [
    { name: "read_issue", description: "Read a GitHub issue by owner, repo, and number.", requiresApproval: false },
    { name: "read_file", description: "Read a repository file at an optional ref.", requiresApproval: false },
    { name: "add_verified_label", description: "Add reprosmith:verified after proof is complete.", requiresApproval: true },
    { name: "comment_on_issue", description: "Post a ReproSmith evidence comment.", requiresApproval: true }
  ];
}

export function createGitHubMcpTools({ client }: GitHubMcpServerOptions) {
  return {
    async callTool(call: GitHubMcpToolCall): Promise<GitHubMcpToolResult> {
      switch (call.name) {
        case "read_issue": {
          const { owner, repo, issueNumber } = parseRepoIssueArgs(call.arguments);
          const issue = await client.getIssue(owner, repo, issueNumber);
          return textResult(
            JSON.stringify(
              {
                number: issue.number,
                title: issue.title,
                body: issue.body,
                state: issue.state,
                url: issue.html_url
              },
              null,
              2
            )
          );
        }

        case "read_file": {
          const { owner, repo, path, ref } = parseReadFileArgs(call.arguments);
          const file = await client.getFile(owner, repo, path, ref);
          return textResult(JSON.stringify(file, null, 2));
        }

        case "add_verified_label": {
          assertApproved(call.approval);
          const { owner, repo, issueNumber } = parseRepoIssueArgs(call.arguments);
          await client.addLabels(owner, repo, issueNumber, ["reprosmith:verified"]);
          return textResult("Added reprosmith:verified label.");
        }

        case "comment_on_issue": {
          assertApproved(call.approval);
          const { owner, repo, issueNumber } = parseRepoIssueArgs(call.arguments);
          const body = expectString(call.arguments.body, "body");
          const comment = await client.createIssueComment(owner, repo, issueNumber, body);
          return textResult(`Created comment: ${comment.html_url}`);
        }
      }
    }
  };
}

function textResult(text: string): GitHubMcpToolResult {
  return { content: [{ type: "text", text }] };
}

function assertApproved(approval: ApprovalContext | undefined): void {
  if (!approval?.approved) {
    throw new Error("GitHub write blocked: approval is required");
  }

  if (
    approval.expectedPayloadHash &&
    approval.payloadHash &&
    approval.expectedPayloadHash !== approval.payloadHash
  ) {
    throw new Error("GitHub write blocked: approval payload hash mismatch");
  }
}

function parseRepoIssueArgs(args: Record<string, unknown>) {
  return {
    owner: expectString(args.owner, "owner"),
    repo: expectString(args.repo, "repo"),
    issueNumber: expectNumber(args.issueNumber, "issueNumber")
  };
}

function parseReadFileArgs(args: Record<string, unknown>) {
  return {
    owner: expectString(args.owner, "owner"),
    repo: expectString(args.repo, "repo"),
    path: expectString(args.path, "path"),
    ref: typeof args.ref === "string" ? args.ref : undefined
  };
}

function expectString(value: unknown, name: string): string {
  if (typeof value !== "string" || value.length === 0) {
    throw new Error(`Expected non-empty string argument: ${name}`);
  }

  return value;
}

function expectNumber(value: unknown, name: string): number {
  if (typeof value !== "number" || !Number.isInteger(value)) {
    throw new Error(`Expected integer argument: ${name}`);
  }

  return value;
}
