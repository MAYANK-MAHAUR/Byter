# Byter Architecture

```text
GitHub issues webhook
        |
        v
Byter server
  - HMAC verification and delivery deduplication
  - issue security scan
  - run JSONL persistence
  - append-only progress comments and a proof-gated verified label per issue run
        |
        v
TrueForge session and turn
  - configured model provider (AgentRouter)
  - GitHub MCP read boundary
  - Daytona sandbox
  - optional dynamic subagents
        |
        v
Bounded harness trace projection
  - session / agent / MCP / sandbox / subagent events
  - redacted command output and summaries
  - no private chain-of-thought
        |
        v
Proof result -> awaiting approval -> GitHub MCP draft PR
```

## Event Boundary

The TrueForge adapter receives provider events, but the server persists only a
bounded projection. Tool names, repository targets, sandbox IDs, commands,
exit codes, artifact names, and small redacted output snippets are retained.
Model messages are reduced to safe high-level summaries. Raw event payloads,
credentials, and hidden reasoning are not written to `webhook-runs.jsonl`.

The projection is appended while the turn streams and is also refreshed from
the TrueForge session when a historical record still contains the old
sequence/type-only format. The dashboard reads `/api/runs/latest` for the
console root and `/api/runs/:runId` for permanent run links.

## Approval Boundary

Reproduction and patch validation happen before repository mutation. A live
candidate patch enters `awaiting-approval`; the dashboard shows the pre-write
state and the GitHub progress comment says that no branch or pull request exists.
The authenticated approval API validates the run ID and payload hash before
calling the `create_fix_pull_request` MCP tool. The resulting branch, commit,
and draft PR receipt are stored with the run and a new GitHub progress comment
is added. After complete proof, the server also applies the
`byter:verified` label through the configured GitHub client.

The current implementation uses a server-side approval checkpoint and an
approved MCP tool call. It does not claim that the initial proof turn itself
is suspended inside TrueForge; that boundary is intentionally visible in the
audit and UI.

## Persistence

JSONL under `DATA_DIR` gives the single Railway service reconnectable run
records without adding a database dependency. Use a mounted volume for the
demo. A multi-instance production deployment should replace this layer with a
transactional store and an indexed event table.
