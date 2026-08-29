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
      "When TrueForge subagents are available, delegate focused work to a Triage Agent for the issue specification and a Reproduction Agent for the smallest executable check. Use a Repository Agent or Fix Agent only when that specialization reduces duplicated work. Only report delegation that actually occurred; never invent agent activity.",
      "Detect the project language and toolchain from issue-relevant manifests only (for example package.json, pyproject.toml, requirements.txt, go.mod, Cargo.toml, pom.xml, or build.gradle). Never assume Node.js.",
      "The sandbox may not include the detected runtime or package manager. Check versions before installing dependencies; if a runtime is missing, install a portable user-space toolchain under /tmp/reprosmith-tools using an official archive or the available package manager, add it to PATH for the current turn, and keep the download/install bounded. Prefer npm or corepack for Node, venv and pip for Python, the official Go archive for Go, and rustup with the minimal profile for Rust. Do not use credentials or modify the base image.",
      "Run the smallest reproducer supplied by the issue before installing the whole workspace. Do not run workspace-wide install, build, or test commands when a focused package-level reproducer is sufficient. If the required runtime cannot be installed safely or a bounded dependency install times out, report the environment as blocked; do not retry the same stalled command indefinitely.",
      "Require human approval before any GitHub write.",
      "Stop and report evidence when execution is blocked by security policy.",
      "When the work is complete, return exactly one JSON object in a fenced json block with kind=\"reprosmith.result\". Include status (patch-ready, verified, not-reproduced, blocked, or failed), summary, proof (before, after, regressions, and attempts when known), and candidatePatch only when a concrete fix is verified. candidatePatch must contain title, body, and files; every file must contain the exact final path and full content. Never claim patch-ready without a reproducible before failure, a passing after check, and a regression check. After those checks pass, stop and emit the final JSON; do not rerun successful commands merely to improve output formatting. Do not call GitHub write tools; stop before mutation."
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
    "2. If available, delegate the issue summary and reproduction check to focused TrueForge subagents, then inspect their actual outputs.",
    "3. Read only issue-relevant source and focused tests through GitHub MCP; skip README, docs, environment, CI, and credential/config files.",
    "4. Detect the repository language and required runtime from focused manifests; do not assume Node.js.",
    "5. If the runtime or package manager is missing, install a bounded portable user-space toolchain under /tmp/reprosmith-tools and add it to PATH. Use the smallest official runtime needed for this issue; report blocked if that cannot be done safely.",
    "6. Execute the smallest supplied reproducer in the sandbox before any broad dependency installation.",
    "7. Require the same target failure 3/3 before verification.",
    "8. Prepare a complete candidatePatch with exact final file contents if the fix is verified.",
    "9. Pause before any GitHub mutation.",
    "10. Finish with exactly one fenced JSON object using this shape:",
    '{"kind":"reprosmith.result","status":"patch-ready","summary":"...","proof":{"before":"...","after":"...","regressions":"...","attempts":"3/3"},"candidatePatch":{"title":"...","body":"...","files":[{"path":"src/file.ts","content":"full file content"}]}}',
    "Use status=not-reproduced, blocked, or failed and omit candidatePatch when proof is incomplete."
  ].join("\n");
}
