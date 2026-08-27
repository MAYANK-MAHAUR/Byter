import { describe, expect, it } from "vitest";
import { GitHubRestClient } from "../src/index.js";

describe("GitHubRestClient", () => {
  it("uses GitHub REST headers and encodes content path segments", async () => {
    const calls: Array<{ url: string; init: RequestInit }> = [];
    const fetchImpl = (async (url: string | URL | Request, init?: RequestInit) => {
      calls.push({ url: String(url), init: init ?? {} });
      return new Response(
        JSON.stringify({ path: "src/file name.ts", sha: "abc", encoding: "base64", content: "YQ==" }),
        { status: 200, headers: { "Content-Type": "application/json" } }
      );
    }) as typeof fetch;

    const client = new GitHubRestClient({
      token: "token",
      apiBaseUrl: "https://api.github.test",
      fetchImpl
    });

    await client.getFile("owner-name", "repo.name", "src/file name?#.ts", "main");

    expect(calls[0]?.url).toBe(
      "https://api.github.test/repos/owner-name/repo.name/contents/src/file%20name%3F%23.ts?ref=main"
    );
    expect((calls[0]?.init.headers as Record<string, string>)["User-Agent"]).toBe("ReproSmith/0.1.0");
    expect((calls[0]?.init.headers as Record<string, string>).Authorization).toBe("Bearer token");
  });

  it("rejects owner or repo values that would escape REST path segments", async () => {
    const client = new GitHubRestClient({
      token: "token",
      fetchImpl: (() => {
        throw new Error("fetch should not be called");
      }) as typeof fetch
    });

    await expect(client.getIssue("owner/name", "repo", 1)).rejects.toThrow("Invalid GitHub owner");
    await expect(client.getIssue("owner", "repo/name", 1)).rejects.toThrow("Invalid GitHub repository name");
  });

  it("rejects traversal repository paths before making a request", async () => {
    const client = new GitHubRestClient({
      token: "token",
      fetchImpl: (() => {
        throw new Error("fetch should not be called");
      }) as typeof fetch
    });

    await expect(client.getFile("owner", "repo", "../issues/1")).rejects.toThrow("Invalid GitHub repository path");
    await expect(client.getFile("owner", "repo", "src/../token")).rejects.toThrow(
      "Invalid GitHub repository path"
    );
    await expect(client.getFile("owner", "repo", "/src/token.ts")).rejects.toThrow("Invalid GitHub repository path");
  });
});
