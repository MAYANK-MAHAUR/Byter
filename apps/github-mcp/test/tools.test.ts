import { describe, expect, it, vi } from "vitest";
import { approvalPayloadHash, createGitHubMcpTools, listGitHubTools } from "../src/index.js";

describe("GitHub MCP tools", () => {
  it("exposes read and approved write tools", () => {
    expect(listGitHubTools()).toEqual([
      expect.objectContaining({ name: "read_issue", requiresApproval: false }),
      expect.objectContaining({ name: "read_file", requiresApproval: false }),
      expect.objectContaining({ name: "add_verified_label", requiresApproval: true }),
      expect.objectContaining({ name: "comment_on_issue", requiresApproval: true })
    ]);
  });

  it("reads issues through the GitHub client", async () => {
    const client = {
      getIssue: vi.fn().mockResolvedValue({
        number: 3,
        title: "Bug",
        body: "Breaks",
        state: "open",
        html_url: "https://github.test/issue/3"
      })
    };
    const tools = createGitHubMcpTools({ client: client as never });

    const result = await tools.callTool({
      name: "read_issue",
      arguments: { owner: "o", repo: "r", issueNumber: 3 }
    });

    expect(client.getIssue).toHaveBeenCalledWith("o", "r", 3);
    expect(result.content[0]?.text).toContain("\"title\": \"Bug\"");
  });

  it("blocks writes without approval", async () => {
    const client = { addLabels: vi.fn() };
    const tools = createGitHubMcpTools({ client: client as never });

    await expect(
      tools.callTool({
        name: "add_verified_label",
        arguments: { owner: "o", repo: "r", issueNumber: 3 }
      })
    ).rejects.toThrow("approval is required");

    expect(client.addLabels).not.toHaveBeenCalled();
  });

  it("blocks writes without a payload-specific approval hash", async () => {
    const client = { addLabels: vi.fn() };
    const tools = createGitHubMcpTools({ client: client as never });

    await expect(
      tools.callTool({
        name: "add_verified_label",
        arguments: { owner: "o", repo: "r", issueNumber: 3 },
        approval: { approved: true }
      })
    ).rejects.toThrow("approval payload hash is required");

    expect(client.addLabels).not.toHaveBeenCalled();
  });

  it("blocks writes when approval was for a different payload", async () => {
    const client = { addLabels: vi.fn() };
    const tools = createGitHubMcpTools({ client: client as never });
    const hashForIssueThree = approvalPayloadHash("add_verified_label", {
      owner: "o",
      repo: "r",
      issueNumber: 3
    });

    await expect(
      tools.callTool({
        name: "add_verified_label",
        arguments: { owner: "o", repo: "r", issueNumber: 4 },
        approval: { approved: true, expectedPayloadHash: hashForIssueThree }
      })
    ).rejects.toThrow("approval payload hash mismatch");

    expect(client.addLabels).not.toHaveBeenCalled();
  });

  it("allows writes with a matching payload-specific approval hash", async () => {
    const client = { addLabels: vi.fn().mockResolvedValue(undefined) };
    const tools = createGitHubMcpTools({ client: client as never });
    const args = { owner: "o", repo: "r", issueNumber: 3 };

    await tools.callTool({
      name: "add_verified_label",
      arguments: args,
      approval: { approved: true, expectedPayloadHash: approvalPayloadHash("add_verified_label", args) }
    });

    expect(client.addLabels).toHaveBeenCalledWith("o", "r", 3, ["reprosmith:verified"]);
  });
});
