# ReproSmith

CI for bug reports.

Don't let AI decide whether a bug is real. Make it prove it.

ReproSmith turns GitHub issue reports into executable evidence. The first milestone is a deterministic vertical slice: receive a controlled issue, triage it, run a sandboxed reproduction against a pinned commit, prove the same failure repeatedly, pause for maintainer approval, and only then prepare a GitHub write.

## Status

This repository has been reset as a fresh hackathon build for the TrueForge Agent Harness Hackathon.

## Local Setup

```bash
pnpm install
pnpm test
pnpm typecheck
pnpm build
pnpm demo:e2e
```

## Demo Path

`pnpm demo:e2e` runs a local end-to-end proof loop with no GitHub writes. It scans safe and quarantined issue text, drives the ReproSmith state machine, verifies the seeded parser crash three times, validates a candidate patch in a disposable workspace, and prints the evidence summary as JSON.

## Environment

Copy `.env.example` to `.env.local` and fill in local secrets. Do not commit `.env.local`.

## Planned Phases

1. Foundation: pnpm workspace, shared types, state machine, seeded demo fixture.
2. GitHub plumbing: webhook verification, narrow GitHub client, MCP-style read/write boundaries.
3. TrueForge runtime: session orchestration, subagent boundaries, sandbox execution proof.
4. Reproduction engine: repeated verification, fingerprint matching, minimization.
5. Patch validation: before/after proof, approval checkpoint, draft PR creation.
6. Dashboard: run timeline, evidence, approval controls, security quarantine view.
7. Demo and hardening: e2e path, security fixtures, setup docs.
