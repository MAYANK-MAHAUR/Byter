# UX audit

## Current GitHub comment problems

- A run creates multiple progress comments instead of maintaining one status comment.
- The final comment is too long for issue triage: it includes full file contents, verbose sandbox logs, full patch hashes, model/runtime detail, and a long approval instruction.
- The useful action is buried below the proof instead of linking directly to the page where a maintainer can review and approve.
- The current comment does not clearly separate the verified finding, proposed remedy, validation result, and the fact that no repository mutation has happened yet.
- Status labels are useful, but their lifecycle is not presented as a clean state transition from triage to verified, awaiting approval, and draft PR.

## Current dashboard problems

- The dashboard has the right raw ingredients, but Overview, Reproduction, Patch, and Harness Trace do not form a clear review sequence.
- The overview repeats long model summaries instead of presenting a compact root cause, proposed fix, and proof at a glance.
- Patch review shows proposed file contents rather than a focused before/after diff with validation context.
- There is no dedicated review route that opens directly from GitHub with the approval gate visible.
- Test evidence is mixed into proof prose and trace output; there is no concise Tests view with expandable raw logs.
- The current navigation omits a Tests tab and does not distinguish the maintainer review workflow from general run exploration.

## Current approval problems

- The website approval control exists, but GitHub directs maintainers toward a command rather than the primary review page.
- The approval card does not make the requested repository action prominent enough: resume TrueForge, create a branch, commit the verified patch, and open a draft PR.
- The exact patch is not easy to inspect before approval because the review surface is spread across a long comment and the Patch tab.
- The backend creates a separate approval comment instead of editing the run's main status comment after a decision.
- The post-approval state needs to show the actual draft PR and remove awaiting-approval language.

## Existing useful components

- Persisted run records already retain TrueForge sessions, bounded trace events, proof fields, candidate patch files, labels, and pull request metadata.
- The website already has reusable timeline, harness, trace, reproduction, patch, security, and approval components.
- The TrueForge harness panel exposes model/provider, session, MCP, sandbox, subagent, and trace counts.
- The server already verifies GitHub webhooks, checks maintainer permissions, validates approval hashes, and gates repository writes.
- The GitHub client already supports issue comments, comment updates, labels, collaborator permissions, and draft pull requests.

## Changes required

- Add persisted concise `rootCauseSummary` and `proposedFixSummary` fields and reuse them everywhere.
- Replace comment creation after the first update with an edit of the same GitHub comment, keeping GitHub concise and scannable.
- Add a direct `/runs/<run-id>/review` route with proof, actual patch/diff, tests, paused mutation state, and `Approve & Resume`.
- Add a Tests tab and restructure Overview, Reproduction, Patch, and Harness Trace around summary-first progressive disclosure.
- Keep raw logs, file contents, hashes, session identifiers, and detailed trace rows on the website behind expandable controls.
- Add lifecycle label synchronization for triaging, verified, needs-info, not-reproduced, security-review, awaiting-approval, and pr-created.
- Add comment rendering fixtures for every major run state and verify the real GitHub comment plus direct review link after deployment.
