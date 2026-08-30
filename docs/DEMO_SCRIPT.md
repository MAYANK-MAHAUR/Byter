# Byter Demo Script

Target length: about 2 minutes 40 seconds at a natural speaking pace.

## 0:00-0:20 - The problem

**On screen:** Open the Byter dashboard.

**Say:**

"This is Byter, CI for bug reports. A bug report normally gives a maintainer a claim and a lot of manual work. Byter turns that claim into executable evidence, proposes a tested fix, and stops before changing the repository."

## 0:20-0:40 - Start from GitHub

**On screen:** Show issue #29 and its `byter:run` label.

**Say:**

"The workflow starts from an ordinary GitHub issue. I add the Byter run label, and the signed webhook creates a durable investigation. The issue text is treated as untrusted input and scanned before the model receives it."

## 0:40-1:15 - TrueForge working live

**On screen:** Open the permanent run URL. Point to the current task, repository calls, sandbox steps, and agent activity. Then open **Harness trace**.

**Say:**

"TrueForge is the harness behind the run. It gives the model scoped GitHub MCP tools for repository context and a disposable Daytona sandbox for execution. This is live data: we can see the files it inspected, tool responses, sandbox commands, and bounded output. We show observable actions and evidence, not private chain-of-thought or internal credentials. The run is persisted, so I can refresh or return through the same URL without losing the investigation."

## 1:15-1:50 - Executable proof

**On screen:** Open **Reproduction**, then the run overview.

**Say:**

"Here the report says escaped uppercase literals are being lowercased. Byter reproduced the same target failure three out of three times. The candidate change preserves the escaped character, the same reproducer passes after the patch, and the regression suite remains green. The finding is backed by commands and output, not just an AI summary."

## 1:50-2:20 - Human control

**On screen:** Open **Patch** or the review page. Show the diff and the approval status.

**Say:**

"Now the important boundary: nothing has been written to GitHub. The maintainer can inspect the exact files, diff, reproduction result, and regression evidence before deciding. Reject closes the run. Approve allows only the verified candidate change to become a draft pull request."

## 2:20-2:40 - Approve where maintainers work

**On screen:** Show the GitHub progress comment and its approval instruction. Do not approve the prepared showcase run unless you want to create a new draft PR.

**Say:**

"Approval also works where maintainers already work. A repository maintainer can reply with the single word approve on the issue. Byter verifies the actor, resumes the persisted run, and records each GitHub write as a new update instead of hiding history in one edited comment."

## 2:40-2:55 - Code quality and close

**On screen:** Open merged PR #23 and briefly show the Qodo review.

**Say:**

"We also used Qodo throughout development. Its reviews caught security, persistence, event identity, and reliability issues that we fixed and re-reviewed. Byter makes AI bug fixing useful because the model must prove the failure, prove the fix, and still wait for a human."

## Recording Checklist

- Use the production app and a persisted live run, not the fixture mode.
- Keep the browser zoom near 100 percent and close unrelated tabs.
- Show TrueForge, MCP calls, sandbox execution, reconnectability, and the approval pause.
- Show the proposed diff before mentioning approval.
- End on the merged Qodo-reviewed pull request.
- Keep the recording below three minutes.
