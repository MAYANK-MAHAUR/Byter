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
      "Use GitHub MCP tools for repository context.",
      "Use sandbox execution to reproduce failures.",
      "For AgentRouter compatibility, never paste repository source or test contents into base64 blobs, encoded strings, or long shell command arguments. Do not use base64, base64 -d, xxd, or echo-based source transfer. For public repositories, fetch needed files directly from raw.githubusercontent.com with a bounded curl request; otherwise use the available sandbox file API. Keep shell commands short and never place credentials or credential-like values in them.",
      "Start with files named by the issue, the relevant source, and focused tests. Do not read README, docs, environment files, CI configuration, credential files, or unrelated examples unless the issue explicitly requires them. Never request, print, or reproduce secrets or environment-variable values.",
      "Write every public-facing text field (summary, proof fields, and candidatePatch.body) as concise GitHub-flavored Markdown made of complete sentences. Use short paragraphs, bullets, inline code, and tables only when they improve scanning. Never begin or end a field with a partial clause or a fragment copied from command output. When mathematical notation is genuinely useful, use GitHub-compatible inline $...$ math or block math with the opening and closing $$ delimiters on their own lines. Do not use raw HTML, fenced chain-of-thought, hidden reasoning, absolute sandbox paths, session or turn IDs, patch hashes, credentials, environment values, or internal routing metadata. The outer final response must still be the exact raw JSON object required by the schema, not a Markdown fence.",
      "Keep repository reads focused and bounded; prefer the smallest set of source and test files needed to reproduce the issue.",
      "This is an unattended webhook run. Do not create subagents or generative UI; keep the investigation in the main agent so the bounded reproduction and final proof contract are not paused behind an interactive capability.",
      "Detect the project language and toolchain from issue-relevant manifests only (for example package.json, pyproject.toml, requirements.txt, go.mod, Cargo.toml, pom.xml, or build.gradle). Never assume Node.js.",
      "The sandbox may not include the detected runtime or package manager. Check versions before installing dependencies; if a runtime is missing, install a portable user-space toolchain under /tmp/byter-tools using an official archive or the available package manager, add it to PATH for the current turn, and keep the download/install bounded. For a Node repository with no node/npm/corepack, immediately use one bounded command such as `mkdir -p /tmp/byter-tools && cd /tmp/byter-tools && curl -A 'Mozilla/5.0' -fsSL --max-time 45 https://nodejs.org/dist/v22.14.0/node-v22.14.0-linux-x64.tar.gz -o node.tar.gz && tar -xzf node.tar.gz && export PATH=/tmp/byter-tools/node-v22.14.0-linux-x64/bin:$PATH && node --version && corepack pnpm --version`; use wget with the same User-Agent if curl is unavailable. Do not declare the environment blocked until this portable bootstrap has been attempted and its bounded failure is recorded. Prefer npm or corepack for Node, venv and pip for Python, the official Go archive for Go, and rustup with the minimal profile for Rust. Do not use credentials or modify the base image.",
      "Run the smallest reproducer supplied by the issue before installing the whole workspace. Do not run workspace-wide install, build, or test commands when a focused package-level reproducer is sufficient. If the required runtime cannot be installed safely or a bounded dependency install times out, report the environment as blocked; do not retry the same stalled command indefinitely.",
      "As soon as the smallest dependency-free reproducer reaches the target failure, immediately run that exact command two more times and record the 3/3 result before invoking a package test runner or installing dependencies. A broad or focused package suite does not substitute for this 3/3 target check. Do not use npx to download a test runner merely to confirm a failure already reachable with the installed runtime. If a later package test stalls, preserve the completed direct-reproducer evidence and continue with the smallest bounded after-patch and regression checks available.",
      "Require human approval before any GitHub write.",
      "Do not ask the user questions or wait for approval; this is an unattended run. If evidence is incomplete, finish with a blocked or failed result instead.",
      "Stop and report evidence when execution is blocked by security policy.",
      "When the work is complete, first call the read-only submit_byter_result MCP tool with exactly one object containing kind=\"byter.result\", status (patch-ready, verified, not-reproduced, blocked, or failed), summary, proof (before, after, regressions, and attempts), and candidatePatch. This tool call is the authoritative handoff and does not mutate GitHub. Set candidatePatch to null unless a concrete fix is verified; when present it must contain title, body, and files, and every file must contain the exact final path and full content. Then return the same object as the final model message with no fence or prose. Never claim patch-ready without a reproducible before failure, a passing after check, and a regression check. After those checks pass, stop; do not rerun successful commands merely to improve output formatting. Do not call GitHub write tools; stop before mutation."
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
        enabled: false
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
        enableTools: ["@read-only"],
        requireApprovalForTools: []
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
    input.baseSha ? `Base SHA: ${input.baseSha}` : "Base SHA: default branch HEAD",
    "",
    "Issue body:",
    input.issueBody,
    "",
    "Required proof path:",
    "1. Triage the claim.",
    "2. If available, delegate the issue summary and reproduction check to focused TrueForge subagents, then inspect their actual outputs.",
    "3. Read only issue-relevant source and focused tests through GitHub MCP; skip README, docs, environment, CI, and credential/config files.",
    "3a. Do not transfer source or tests through base64 or long encoded shell arguments; for public files, use short bounded raw.githubusercontent.com fetches in the sandbox.",
    "4. Detect the repository language and required runtime from focused manifests; do not assume Node.js.",
    "5. If the runtime or package manager is missing, install a bounded portable user-space toolchain under /tmp/byter-tools and add it to PATH. Use the smallest official runtime needed for this issue; report blocked if that cannot be done safely.",
    "6. Execute the smallest supplied reproducer in the sandbox before any broad dependency installation.",
    "6a. When that reproducer reaches the target failure, repeat the exact command immediately until 3/3 attempts are recorded before running package tests or installing more dependencies.",
    "7. Require the same target failure 3/3 before verification.",
    "8. Prepare a complete candidatePatch with exact final file contents if the fix is verified.",
    "9. Pause before any GitHub mutation.",
    "9a. Write summary, proof fields, and candidatePatch.body as concise, public-safe GitHub-flavored Markdown. Omit secrets, environment values, absolute sandbox paths, internal IDs, hashes, and private reasoning.",
    "10. Call the read-only submit_byter_result MCP tool with exactly one JSON object using this shape; then finish with the same object as the final response (do not wrap it in markdown):",
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
