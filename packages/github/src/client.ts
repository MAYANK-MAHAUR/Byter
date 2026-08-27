export interface GitHubClientOptions {
  token: string;
  apiBaseUrl?: string;
  userAgent?: string;
  fetchImpl?: typeof fetch;
}

export interface GitHubIssue {
  number: number;
  title: string;
  body: string | null;
  html_url: string;
  state: string;
}

export interface GitHubContentFile {
  path: string;
  sha: string;
  encoding: string;
  content: string;
}

export class GitHubRestClient {
  private readonly token: string;
  private readonly apiBaseUrl: string;
  private readonly userAgent: string;
  private readonly fetchImpl: typeof fetch;

  constructor(options: GitHubClientOptions) {
    this.token = options.token;
    this.apiBaseUrl = (options.apiBaseUrl ?? "https://api.github.com").replace(/\/+$/, "");
    this.userAgent = options.userAgent ?? "ReproSmith/0.1.0";
    this.fetchImpl = options.fetchImpl ?? fetch;
  }

  async getIssue(owner: string, repo: string, issueNumber: number): Promise<GitHubIssue> {
    return this.request<GitHubIssue>(`${repoBasePath(owner, repo)}/issues/${validateIssueNumber(issueNumber)}`);
  }

  async getFile(owner: string, repo: string, path: string, ref?: string): Promise<GitHubContentFile> {
    const params = ref ? `?ref=${encodeURIComponent(ref)}` : "";
    return this.request<GitHubContentFile>(
      `${repoBasePath(owner, repo)}/contents/${encodeRepositoryPath(path)}${params}`
    );
  }

  async addLabels(owner: string, repo: string, issueNumber: number, labels: string[]): Promise<void> {
    await this.request(`${repoBasePath(owner, repo)}/issues/${validateIssueNumber(issueNumber)}/labels`, {
      method: "POST",
      body: JSON.stringify({ labels })
    });
  }

  async createIssueComment(
    owner: string,
    repo: string,
    issueNumber: number,
    body: string
  ): Promise<{ html_url: string }> {
    return this.request<{ html_url: string }>(`${repoBasePath(owner, repo)}/issues/${validateIssueNumber(issueNumber)}/comments`, {
      method: "POST",
      body: JSON.stringify({ body })
    });
  }

  private async request<T>(path: string, init: RequestInit = {}): Promise<T> {
    const response = await this.fetchImpl(`${this.apiBaseUrl}${path}`, {
      ...init,
      headers: {
        Accept: "application/vnd.github+json",
        Authorization: `Bearer ${this.token}`,
        "Content-Type": "application/json",
        "User-Agent": this.userAgent,
        "X-GitHub-Api-Version": "2022-11-28",
        ...init.headers
      }
    });

    if (!response.ok) {
      const text = await response.text();
      throw new Error(`GitHub API ${response.status} ${response.statusText}: ${text}`);
    }

    if (response.status === 204) {
      return undefined as T;
    }

    return (await response.json()) as T;
  }
}

function repoBasePath(owner: string, repo: string): string {
  return `/repos/${encodeOwner(owner)}/${encodeRepo(repo)}`;
}

function encodeOwner(owner: string): string {
  if (!/^[A-Za-z0-9](?:[A-Za-z0-9-]{0,37}[A-Za-z0-9])?$/.test(owner)) {
    throw new Error("Invalid GitHub owner");
  }

  return encodeURIComponent(owner);
}

function encodeRepo(repo: string): string {
  if (!/^[A-Za-z0-9._-]{1,100}$/.test(repo)) {
    throw new Error("Invalid GitHub repository name");
  }

  return encodeURIComponent(repo);
}

function validateIssueNumber(issueNumber: number): number {
  if (!Number.isInteger(issueNumber) || issueNumber < 1) {
    throw new Error("Invalid GitHub issue number");
  }

  return issueNumber;
}

function encodeRepositoryPath(path: string): string {
  if (path.length === 0 || path.startsWith("/") || path.includes("\\")) {
    throw new Error("Invalid GitHub repository path");
  }

  return path
    .split("/")
    .map((segment) => {
      if (segment.length === 0 || segment === "." || segment === "..") {
        throw new Error("Invalid GitHub repository path");
      }

      return encodeURIComponent(segment);
    })
    .join("/");
}
