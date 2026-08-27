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
      "Require human approval before any GitHub write.",
      "Stop and report evidence when execution is blocked by security policy."
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
    mcpServers: [{ name: "reprosmith-github" }]
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
    "2. Read repository context through GitHub MCP.",
    "3. Execute a reproducer in sandbox.",
    "4. Require the same target failure 3/3 before verification.",
    "5. Pause before any GitHub mutation."
  ].join("\n");
}
