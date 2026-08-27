import { describe, expect, it } from "vitest";
import { GitHubRestClient } from "../src/index.js";

describe("GitHubRestClient", () => {
  it("uses GitHub REST headers and encodes content paths", async () => {
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

    await client.getFile("owner", "repo", "src/file name.ts", "main");

    expect(calls[0]?.url).toBe("https://api.github.test/repos/owner/repo/contents/src/file%20name.ts?ref=main");
    expect((calls[0]?.init.headers as Record<string, string>)["User-Agent"]).toBe("ReproSmith/0.1.0");
    expect((calls[0]?.init.headers as Record<string, string>).Authorization).toBe("Bearer token");
  });
});
