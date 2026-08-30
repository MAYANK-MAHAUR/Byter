# Building Byter: Executable Evidence Before AI Writes Code

Bug trackers are full of claims that may be important but are expensive to verify. A maintainer still has to find the relevant code, recreate the environment, reproduce the failure, identify the cause, test a patch, and decide whether the change is safe. On a large repository, valuable reports can simply disappear in the queue.

We built **Byter**, CI for bug reports, for the TrueForge Agent Harness Hackathon. Byter turns a labeled GitHub issue into a durable investigation with executable evidence. It can prepare a tested candidate fix, but it pauses before changing the repository.

## The Workflow

A signed GitHub webhook starts each run. Byter first treats the issue body as untrusted input and scans it for prompt injection, credential requests, and destructive instructions. Safe reports are handed to a TrueForge session with a narrow set of GitHub MCP tools.

The agent reads only the repository context it needs, creates a disposable Daytona sandbox, and builds a focused reproducer. A finding is not verified unless the same target failure appears repeatedly. When the failure is stable, the agent prepares a minimal candidate patch and runs three kinds of evidence: the original failure before the change, the same reproducer after the change, and existing regression checks.

The final boundary is deliberately human. Byter shows the exact patch and test evidence, applies verified and awaiting-approval labels, and writes an append-only progress update to the issue. No branch, commit, or pull request exists yet. A repository maintainer can approve in the dashboard or reply with the single word `approve` on GitHub. Only then can the scoped write tools create a draft pull request.

## Why TrueForge Mattered

TrueForge is not a name added around a normal API call. It is the runtime that makes the investigation durable and observable. It owns the model turn, GitHub MCP connection, Daytona sandbox, tool events, and structured result contract. Byter persists those events behind a permanent run URL, so a maintainer can refresh, reconnect, and understand what already happened.

That visibility shaped the product. The dashboard shows the current task, repository calls, inspected files, sandbox commands, bounded output, reproduction attempts, patch proof, and approval state. It intentionally does not expose private chain-of-thought or sensitive provider and infrastructure details.

Our public [issue #32 run](https://byter-production-1024.up.railway.app/runs/github-MAYANK-MAHAUR-Byter-32-8fd16ca98fd2) demonstrates the complete boundary. TrueForge recorded 57 harness events, including 11 repository-tool events and 22 sandbox events. The bug reproduced three out of three times, passed three out of three after the candidate fix, and remained paused before any GitHub mutation.

## What Qodo Changed

We used Qodo on focused pull requests throughout development. The useful part was not the summary; it was the repeated review-and-fix loop.

Qodo found cases where lifecycle labels could retrigger work, public traces could expose secrets or local paths, host headers could influence dashboard links, concurrent updates could duplicate persisted records, and event identifiers could collide. It also identified oversized polling records that increased storage pressure.

We responded with public-data normalization, quoted-secret and path redaction, trusted application URLs, stable run and event identities, corrected label handling, deduplicated writes, bounded persistence, and targeted tests. The [detailed review on PR #23](https://github.com/MAYANK-MAHAUR/Byter/pull/23#issuecomment-5462238474) records the findings, and the [follow-up review](https://github.com/MAYANK-MAHAUR/Byter/pull/23#issuecomment-5468354710) confirms that no active findings remained.

## What We Learned

The hardest part of an AI coding agent is not generating a plausible patch. It is building a trustworthy boundary around that patch.

Evidence has to be executable and specific to the reported failure. Tool activity has to be visible without leaking secrets. Long-running work has to survive reconnects. Approval has to happen before the irreversible step, not after it. Finally, the implementation itself needs ordinary engineering discipline: small pull requests, automated checks, security review, and follow-up fixes.

Byter combines those ideas into one workflow: **prove the bug, prove the fix, and keep the human in control.**

## Try It

- [Live Byter dashboard](https://byter-production-1024.up.railway.app/)
- [Verified run](https://byter-production-1024.up.railway.app/runs/github-MAYANK-MAHAUR-Byter-32-8fd16ca98fd2)
- [Source issue](https://github.com/MAYANK-MAHAUR/Byter/issues/32)
- [Repository](https://github.com/MAYANK-MAHAUR/Byter)
