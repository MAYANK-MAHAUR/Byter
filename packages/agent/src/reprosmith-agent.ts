import type { StartReproSmithSessionInput, TrueForgeRuntimeConfig } from "./types.js";

const reproSmithResultSchema = {
  type: "json_schema" as const,
  jsonSchema: {
    name: "reprosmith_result",
    description: "Executable evidence and, only when verified, a complete candidate patch.",
    strict: true,
    schema: {
      type: "object",
      additionalProperties: false,
      properties: {
        kind: { type: "string", const: "reprosmith.result" },
        status: {
          type: "string",
          enum: ["patch-ready", "verified", "not-reproduced", "blocked", "failed"]
        },
        summary: { type: "string" },
        rootCauseSummary: { type: "string" },
        proposedFixSummary: { type: "string" },
        proof: {
          type: "object",
          additionalProperties: false,
          properties: {
            before: { type: "string" },
            after: { type: "string" },
            regressions: { type: "string" },
            attempts: { type: "string" }
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
                body: { type: "string" },
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

export function buildReproSmithAgentSpec(config: TrueForgeRuntimeConfig) {
  return {
    model: {
      name: `${config.modelProvider ?? "custom"}/${config.modelName}`
    },
    responseFormat: reproSmithResultSchema,
    instructions: [
      "You are ReproSmith, CI for bug reports.",
      "Do not mark a bug verified from model confidence.",
      "Use GitHub MCP tools for repository context.",
      "Use sandbox execution to reproduce failures.",
      "Start with files named by the issue, the relevant source, and focused tests. Do not read README, docs, environment files, CI configuration, credential files, or unrelated examples unless the issue explicitly requires them. Never request, print, or reproduce secrets or environment-variable values.",
      "Keep repository reads focused and bounded; prefer the smallest set of source and test files needed to reproduce the issue.",
      "This is an unattended webhook run. Do not create subagents or generative UI; keep the investigation in the main agent so the bounded reproduction and final proof contract are not paused behind an interactive capability.",
      "Detect the project language and toolchain from issue-relevant manifests only (for example package.json, pyproject.toml, requirements.txt, go.mod, Cargo.toml, pom.xml, or build.gradle). Never assume Node.js.",
      "The sandbox may not include the detected runtime or package manager. Check versions before installing dependencies; if a runtime is missing, install a portable user-space toolchain under /tmp/reprosmith-tools using an official archive or the available package manager, add it to PATH for the current turn, and keep the download/install bounded. For a Node repository with no node/npm/corepack, immediately use one bounded command such as `mkdir -p /tmp/reprosmith-tools && cd /tmp/reprosmith-tools && curl -A 'Mozilla/5.0' -fsSL --max-time 45 https://nodejs.org/dist/v22.14.0/node-v22.14.0-linux-x64.tar.gz -o node.tar.gz && tar -xzf node.tar.gz && export PATH=/tmp/reprosmith-tools/node-v22.14.0-linux-x64/bin:$PATH && node --version && corepack pnpm --version`; use wget with the same User-Agent if curl is unavailable. Do not declare the environment blocked until this portable bootstrap has been attempted and its bounded failure is recorded. Prefer npm or corepack for Node, venv and pip for Python, the official Go archive for Go, and rustup with the minimal profile for Rust. Do not use credentials or modify the base image.",
      "Run the smallest reproducer supplied by the issue before installing the whole workspace. Do not run workspace-wide install, build, or test commands when a focused package-level reproducer is sufficient. If the required runtime cannot be installed safely or a bounded dependency install times out, report the environment as blocked; do not retry the same stalled command indefinitely.",
      "Require human approval before any GitHub write.",
      "Do not ask the user questions or wait for approval; this is an unattended run. If evidence is incomplete, finish with a blocked or failed result instead.",
      "Stop and report evidence when execution is blocked by security policy.",
      "When the work is complete, first call the read-only submit_reprosmith_result MCP tool with exactly one object containing kind=\"reprosmith.result\", status (patch-ready, verified, not-reproduced, blocked, or failed), summary, concise rootCauseSummary, concise proposedFixSummary, proof (before, after, regressions, and attempts), and candidatePatch. Keep rootCauseSummary and proposedFixSummary to 1-2 sentences each for the maintainer review. This tool call is the authoritative handoff and does not mutate GitHub. Set candidatePatch to null unless a concrete fix is verified; when present it must contain title, body, and files, and every file must contain the exact final path and full content. Then return the same object as the final model message with no fence or prose. Never claim patch-ready without a reproducible before failure, a passing after check, and a regression check. After those checks pass, stop; do not rerun successful commands merely to improve output formatting. Do not call GitHub write tools; stop before mutation."
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
        name: config.mcpServerName ?? "reprosmith-github",
        preload: true,
        enableTools: ["@read-only"],
        requireApprovalForTools: []
      }
    ]
  };
}

export function buildInitialUserMessage(input: StartReproSmithSessionInput): string {
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
    "4. Detect the repository language and required runtime from focused manifests; do not assume Node.js.",
    "5. If the runtime or package manager is missing, install a bounded portable user-space toolchain under /tmp/reprosmith-tools and add it to PATH. Use the smallest official runtime needed for this issue; report blocked if that cannot be done safely.",
    "6. Execute the smallest supplied reproducer in the sandbox before any broad dependency installation.",
    "7. Require the same target failure 3/3 before verification.",
    "8. Prepare a complete candidatePatch with exact final file contents if the fix is verified.",
    "9. Pause before any GitHub mutation.",
    "10. Call the read-only submit_reprosmith_result MCP tool with exactly one JSON object using this shape; then finish with the same object as the final response (do not wrap it in markdown):",
    '{"kind":"reprosmith.result","status":"patch-ready","summary":"...","rootCauseSummary":"One or two concise sentences.","proposedFixSummary":"One or two concise sentences.","proof":{"before":"...","after":"...","regressions":"...","attempts":"3/3"},"candidatePatch":{"title":"...","body":"...","files":[{"path":"src/file.ts","content":"full file content"}]}}',
    "Use status=not-reproduced, blocked, or failed and set candidatePatch to null when proof is incomplete."
  ].join("\n");
}

export function buildProofContractRecoveryMessage(): string {
  return [
    "Your analysis turn is complete. Do not call tools and do not perform more investigation.",
    "The runtime did not receive a valid reprosmith.result object from the previous final response.",
    "Convert only evidence actually observed in this session into exactly one raw JSON object using the enforced reprosmith_result schema.",
    "Do not invent commands, test results, files, or a patch. If the evidence is incomplete, use status=blocked or failed and candidatePatch=null.",
    "Call the read-only submit_reprosmith_result MCP tool with that exact object if it is available, then return the same object with no markdown, fence, or prose."
  ].join("\n");
}
