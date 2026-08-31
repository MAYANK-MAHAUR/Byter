import type { StartByterSessionInput, TrueForgeRuntimeConfig } from "./types.js";

const byterResultSchema = {
  type: "json_schema" as const,
  jsonSchema: {
    name: "byter_result",
    description: "Executable evidence and, only when verified, a complete candidate patch.",
    strict: true,
    schema: {
      type: "object",
      additionalProperties: false,
      properties: {
        kind: { type: "string", const: "byter.result" },
        status: {
          type: "string",
          enum: ["patch-ready", "verified", "not-reproduced", "blocked", "failed"]
        },
        summary: { type: "string", description: "Concise, public-safe GitHub-flavored Markdown summary." },
        proof: {
          type: "object",
          additionalProperties: false,
          properties: {
            before: { type: "string", description: "Concise GitHub-flavored Markdown describing the verified pre-fix failure." },
            after: { type: "string", description: "Concise GitHub-flavored Markdown describing post-fix validation." },
            regressions: { type: "string", description: "Concise GitHub-flavored Markdown describing focused regression checks." },
            attempts: { type: "string", description: "Short reproduction count, for example `3/3 matching failures`." }
          },
          required: ["before", "after", "regressions", "attempts"]
        },
        candidatePatch: {
          anyOf: [
            {
              type: "object",
              additionalProperties: false,
              properties: {
                title: { type: "string" },
                body: { type: "string", description: "Concise, public-safe GitHub-flavored Markdown explaining the proposed remedy." },
                files: {
                  type: "array",
                  items: {
                    type: "object",
                    additionalProperties: false,
                    properties: {
                      path: { type: "string" },
                      content: { type: "string" }
                    },
                    required: ["path", "content"]
                  }
                }
              },
              required: ["title", "body", "files"]
            },
            { type: "null" }
          ]
        }
      },
      required: ["kind", "status", "summary", "proof", "candidatePatch"]
    }
  }
};

export function buildByterAgentSpec(config: TrueForgeRuntimeConfig) {
  return {
    model: {
      name: `${config.modelProvider ?? "custom"}/${config.modelName}`
    },
    responseFormat: byterResultSchema,
    instructions: [
      "You are Byter, CI for bug reports.",
      "Do not mark a bug verified from model confidence.",
      "Use GitHub MCP tools (read_issue, read_file) for repository context. Do not query GitHub REST API or git trees with curl in the sandbox.",
      "MANDATORY SANDBOX EXECUTION: You MUST execute the reproducer in the sandbox using sandbox execution commands. Never stop at static analysis or file inspection. You are the autonomous agent responsible for executing the reproduction commands.",
      "Direct reproduction workflow in the sandbox:",
      "1. Identify the target source and test files from the issue report and read them using GitHub MCP read_file.",
      "2. In the sandbox, write or fetch the target files and reproduction script.",
      "3. If Node.js / toolchain is missing in the sandbox, bootstrap it immediately: `mkdir -p /tmp/byter-tools && cd /tmp/byter-tools && curl -A 'Mozilla/5.0' -fsSL --max-time 45 https://nodejs.org/dist/v22.14.0/node-v22.14.0-linux-x64.tar.gz -o node.tar.gz && tar -xzf node.tar.gz && export PATH=/tmp/byter-tools/node-v22.14.0-linux-x64/bin:$PATH && node --version`.",
      "4. Execute the reproducer command (e.g. `node -e '...'` or test runner) in the sandbox and observe the failure; immediately run that exact command two more times to record the 3/3 before-failure proof.",
      "5. Apply the fix to the file in the sandbox and re-run the reproducer and test suite to confirm the fix passes and regressions pass.",
      "6. Call submit_byter_result with status='patch-ready' and complete proof, then call create_fix_pull_request.",
      "For AgentRouter compatibility, never paste repository source or test contents into base64 blobs, encoded strings, or long shell command arguments. Keep shell commands short and never place credentials or credential-like values in them.",
      "Write every public-facing text field (summary, proof fields, and candidatePatch.body) as concise GitHub-flavored Markdown made of complete sentences. Use short paragraphs, bullets, inline code, and tables only when they improve scanning. When mathematical notation is genuinely useful, use GitHub-compatible inline $...$ math or block math with the opening and closing $$ delimiters on their own lines. Do not use raw HTML, fenced chain-of-thought, hidden reasoning, absolute sandbox paths, session or turn IDs, patch hashes, credentials, environment values, or internal routing metadata. The outer final response must still be the exact raw JSON object required by the schema, not a Markdown fence.",
      "This is an unattended webhook run. Require human approval before any GitHub write.",
      "Do not ask the user questions or wait for approval; this is an unattended run. Never stop or call submit_byter_result before executing the sandbox reproducer.",
      "Stop and report evidence when execution is blocked by security policy.",
      "When the work is complete, first call the read-only submit_byter_result MCP tool with exactly one object containing kind=\"byter.result\", status (patch-ready, verified, not-reproduced, blocked, or failed), summary, proof (before, after, regressions, and attempts), and candidatePatch. This tool call is the authoritative proof handoff and does not mutate GitHub. Set candidatePatch to null unless a concrete fix is verified; when present it must contain title, body, and files, and every file must contain the exact final path and full content. Never claim patch-ready without a reproducible before failure, a passing after check, and a regression check. For a patch-ready result, immediately call create_fix_pull_request with the exact owner, repo, baseBranch, reserved branchName, title, body, and files supplied by the run. TrueForge must pause that write for human approval; never bypass or simulate the approval. After the approved tool call finishes, return the same byter.result object as the final model message with no fence or prose. For every other status, return the object immediately after submit_byter_result."
    ].join("\n"),
    config: {
      iterationLimit: 64,
      askUserQuestions: {
        enabled: false
      },
      generativeUi: {
        enabled: false
      },
      dynamicSubAgents: {
        enabled: true
      },
      sandbox: {
        enabled: true,
        fileDownloads: true
      }
    },
    mcpServers: [
      {
        name: config.mcpServerName ?? "byter-github",
        preload: true,
        enableTools: ["read_issue", "read_file", "submit_byter_result", "create_fix_pull_request"],
        requireApprovalForTools: ["create_fix_pull_request"]
      }
    ]
  };
}

export function buildInitialUserMessage(input: StartByterSessionInput): string {
  return [
    "Analyze this GitHub bug report and build executable reproduction evidence.",
    "",
    `Repository: ${input.repository}`,
    `Issue: ${input.issueUrl}`,
    `Title: ${input.issueTitle}`,
    `Base branch: ${input.baseBranch}`,
    `Reserved fix branch: ${input.branchName}`,
    input.baseSha ? `Base SHA: ${input.baseSha}` : "Base SHA: default branch HEAD",
    "",
    "Issue body:",
    input.issueBody,
    "",
    "Required proof path:",
    "1. Read the target source and test files using GitHub MCP read_file.",
    "2. In the sandbox, bootstrap the runtime if needed and execute the reproducer.",
    "3. repeat the exact command immediately until 3/3 attempts are recorded as before-proof.",
    "4. Require the same target failure 3/3 before verification.",
    "5. Apply the fix and run the reproducer + tests in the sandbox to verify it passes.",
    "6. Prepare a complete candidatePatch with exact final file contents.",
    "7. Submit patch-ready proof with submit_byter_result, then call create_fix_pull_request.",
    "7a. Write summary, proof fields, and candidatePatch.body as concise, public-safe GitHub-flavored Markdown. Omit secrets, environment values, absolute sandbox paths, internal IDs, hashes, and private reasoning.",
    "8. Call the read-only submit_byter_result MCP tool with exactly one JSON object using this shape before requesting the gated write; after the write is approved and completes, finish with the same object as the final response (do not wrap it in markdown):",
    '{"kind":"byter.result","status":"patch-ready","summary":"...","proof":{"before":"...","after":"...","regressions":"...","attempts":"3/3"},"candidatePatch":{"title":"...","body":"...","files":[{"path":"src/file.ts","content":"full file content"}]}}',
    "Use status=not-reproduced, blocked, or failed and set candidatePatch to null when proof is incomplete."
  ].join("\n");
}

export function buildProofContractRecoveryMessage(): string {
  return [
    "Your analysis turn is complete. Do not call tools and do not perform more investigation.",
    "The runtime did not receive a valid byter.result object from the previous final response.",
    "Convert only evidence actually observed in this session into exactly one raw JSON object using the enforced byter_result schema.",
    "Keep all public-facing text fields concise and format them as GitHub-flavored Markdown. Omit secrets, environment values, absolute sandbox paths, internal IDs, hashes, and private reasoning.",
    "Do not invent commands, test results, files, or a patch. If the evidence is incomplete, use status=blocked or failed and candidatePatch=null.",
    "Call the read-only submit_byter_result MCP tool with that exact object if it is available, then return the same object with no markdown, fence, or prose."
  ].join("\n");
}
