# Harness Visibility Audit

Date: 2026-08-29
Repository: `MAYANK-MAHAUR/Byter`
Branch: `feat/harness-visibility`

This audit covers the current Byter/ReproSmith implementation only. It does not
infer behavior from any deleted repository. The production observations below
come from the Railway deployment and the real test issue `#22`.

## Existing and working

| Capability | Evidence in the current implementation |
| --- | --- |
| Signed GitHub issue intake | The webhook verifies the GitHub HMAC signature, validates the event action, and deduplicates delivery IDs. |
| Real TrueForge session and turn | The production issue `#22` created a TrueForge session and turn through the private Railway service. |
| Real GitHub MCP reads | The live agent path is configured with the GitHub MCP tools and the production run reads issue and repository files through that path. |
| Real Daytona execution | Railway TrueForge logs for issue `#22` show a Daytona sandbox being initialized and Code Mode NATS connecting. |
| AgentRouter provider path | The provider request path includes the required `User-Agent: Cline` header and the production run reached the model. |
| Structured proof extraction | The server extracts the final bounded proof and candidate patch from the agent turn. |
| Approval-gated repository mutation | A real approval on the earlier production run created draft PR `#21`; the receipt is persisted and approval is idempotent. |
| Live dashboard polling | The web app polls persisted webhook-run state and displays the current run status. |
| Prompt and credential safety scan | Unsafe issue content is quarantined before the TrueForge session starts, with findings persisted for the UI. |
| Demo and test coverage | The repository has a deterministic demo runner, server/MCP tests, and a full `pnpm verify` path. |
| Durable local run records | Run updates are written to JSONL under the configured data directory. |

## Partially working

| Capability | Current limitation |
| --- | --- |
| Runtime event visibility | TrueForge events are currently persisted only as sequence number and type, without tool arguments, command output, source, or readable summaries. |
| Live activity | The monitor receives the event stream, but the dashboard generally receives the consolidated record after the turn rather than an incremental harness trace. |
| Session identity | Session and turn IDs are stored, but they are not presented as a first-class harness surface with provider and connection state. |
| Subagents | Dynamic subagents are enabled in the agent configuration, but delegation is not required, persisted as a visible event, or proven in the dashboard. |
| Approval checkpoint | The server enters `awaiting-approval` after the proof turn completes and gates the PR write. This is a backend checkpoint, not yet a genuine TrueForge pause/resume turn. |
| GitHub status UX | The `comment_on_issue` MCP tool exists, but the webhook lifecycle does not create or update one status comment containing the permanent dashboard URL. |
| Run addressing | The dashboard primarily shows the latest run rather than a stable `/runs/:runId` view backed by a run-specific API route. |
| Evidence views | Proof, candidate patch, scan findings, and events are present in one basic page, but there are no dedicated Reproduction, Patch, Security, Why Verified, or Harness Trace views. |
| GitHub mutation trace | The final branch, commit, and PR receipt are persisted after approval, but the UI does not render the GitHub action sequence alongside the model and sandbox actions. |
| Persistence | JSONL is suitable for the current single-service deployment but has no query/index layer, retention policy, or multi-instance coordination. |
| GitHub identity | The deployment uses a repository token rather than a GitHub App installation identity. |
| Deployment source | Railway's linked repository metadata still points at an old source path, so deployments use a clean file-backed archive of the current repository. |

## Simulated

| Capability | Boundary |
| --- | --- |
| Deterministic demo run | The demo endpoint intentionally uses fixture data and mocked runtime behavior so the UI can be previewed without spending model or sandbox resources. |
| Core status timeline in demo mode | The status timeline is real UI state, but fixture transitions are not proof of a production TrueForge execution. |
| Unit-test integrations | Server and MCP tests use mocks where appropriate; they validate contracts and safety behavior, not external provider availability. |

The simulated paths are acceptable for local development and regression tests,
but they must be labeled as demo or test data in the product and documentation.

## Missing

- A real event projection with category, source, tool name, MCP server, target, command, exit code, bounded stdout/stderr, artifact, subagent, and approval metadata.
- Incremental persistence and API exposure of that event projection, including reconnect behavior.
- A first-class TrueForge harness panel showing model/provider, session and turn, current task, agent states, MCP calls, sandbox activity, and evidence counts from actual events.
- A dedicated trace view with readable event rows and expandable, redacted evidence rather than private chain-of-thought.
- A single GitHub bot status comment created at investigation start and updated in place through completion, approval, rejection, and failure.
- A permanent dashboard URL embedded in that comment and a run-specific dashboard route.
- A clear approval-paused state with the pre-approval GitHub state, plus explicit post-approval branch, commit, and PR evidence.
- Genuine TrueForge approval resume semantics, or an explicitly documented boundary if the server remains the approval executor.
- A visible Why Verified summary, reproduction evidence, candidate patch evidence, and security findings surface.
- A repository issue form/template and an explicit `reprosmith:run` trigger path that can prevent accidental resource use.
- Product documentation covering architecture, setup, live-vs-demo boundaries, and the approval flow.
- Browser verification of the live route during an active run, browser refresh/reconnect, and the no-branch/no-PR pre-approval state.

## Changes required

1. Define and persist a bounded, redacted harness trace projection from real TrueForge events.
2. Stream trace updates into the persisted run record and expose both latest and run-specific APIs.
3. Add the GitHub status-comment lifecycle and permanent run URL without exposing secrets or model reasoning.
4. Revamp the dashboard around a readable harness panel, trace tabs, evidence tabs, approval state, and post-approval receipt.
5. Make delegation and approval semantics observable and label any remaining backend boundary honestly.
6. Add the issue trigger template and update README, architecture, Railway, and demo documentation.
7. Add focused tests, run the full verification suite, deploy, and verify the real production path with issue `#22` or a fresh labeled issue.
