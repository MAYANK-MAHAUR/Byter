import type { StartReproSmithSessionInput, TrueForgeRuntimeConfig } from "./types.js";

export function buildReproSmithAgentSpec(config: TrueForgeRuntimeConfig) {
  return {
    model: {
      name: `${config.modelProvider ?? "custom"}/${config.modelName}`
    },
    instructions: [
      "You are ReproSmith, CI for bug reports.",
      "Do not mark a bug verified from model confidence.",
      "Use GitHub MCP tools for repository context.",
      "Use sandbox execution to reproduce failures.",
      "Start with files named by the issue, the relevant source, and focused tests. Do not read README, docs, environment files, CI configuration, credential files, or unrelated examples unless the issue explicitly requires them. Never request, print, or reproduce secrets or environment-variable values.",
      "Keep repository reads focused and bounded; prefer the smallest set of source and test files needed to reproduce the issue.",
      "Require human approval before any GitHub write.",
      "Stop and report evidence when execution is blocked by security policy.",
      "When the work is complete, return exactly one JSON object in a fenced json block with kind=\"reprosmith.result\". Include status (patch-ready, verified, not-reproduced, blocked, or failed), summary, proof (before, after, regressions, and attempts when known), and candidatePatch only when a concrete fix is verified. candidatePatch must contain title, body, and files; every file must contain the exact final path and full content. Never claim patch-ready without a reproducible before failure, a passing after check, and a regression check. Do not call GitHub write tools; stop before mutation."
    ].join("\n"),
    config: {
      iterationLimit: 64,
      sandbox: {
        enabled: true,
        fileDownloads: true
      },
      dynamicSubAgents: {
        enabled: true
      }
    },
    mcpServers: [
      {
        name: config.mcpServerName ?? "reprosmith-github",
        preload: true,
        requireApprovalForTools: ["@write", "@destructive"]
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
    "2. Read only issue-relevant source and focused tests through GitHub MCP; skip README, docs, environment, CI, and credential/config files.",
    "3. Execute a reproducer in sandbox.",
    "4. Require the same target failure 3/3 before verification.",
    "5. Prepare a complete candidatePatch with exact final file contents if the fix is verified.",
    "6. Pause before any GitHub mutation.",
    "7. Finish with exactly one fenced JSON object using this shape:",
    '{"kind":"reprosmith.result","status":"patch-ready","summary":"...","proof":{"before":"...","after":"...","regressions":"...","attempts":"3/3"},"candidatePatch":{"title":"...","body":"...","files":[{"path":"src/file.ts","content":"full file content"}]}}',
    "Use status=not-reproduced, blocked, or failed and omit candidatePatch when proof is incomplete."
  ].join("\n");
}
