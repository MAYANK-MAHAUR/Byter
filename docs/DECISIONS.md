# Decisions

## 2026-08-27: Use `MAYANK-MAHAUR/Byter`

Decision:

- Use `https://github.com/MAYANK-MAHAUR/Byter.git` as the project remote.

Reason:

- The attached build specification names `MAYANK-MAHAUR/Byter` as the repository.
- A later note references `ByteHunter`, but current GitHub work is happening in `Byter`.

Alternatives considered:

- Use `MAYANK-MAHAUR/ByteHunter`.

Evidence:

- PRs #1-#6 were opened and merged against `MAYANK-MAHAUR/Byter`.

## 2026-08-27: Keep Commit History Honest

Decision:

- Do not backdate commits, falsify timestamps, or rewrite history to make the project appear older.

Reason:

- The project is for judged hackathon submission.
- Code quality should be demonstrated through real PRs, reviews, tests, and evidence.

Alternatives considered:

- Use `git commit --date` to make work appear spread across earlier dates.

Evidence:

- This repository will preserve an honest checkpoint and PR trail.

## 2026-08-28: Recreate Status And Manual-Action Files

Decision:

- Restore `PROJECT_STATE.md`, `NEEDS_USER.md`, and `docs/DECISIONS.md`.

Reason:

- The build specification requires a decision log, current project state, and manual-blocker list.
- The latest remote main contains implementation work but does not include those status files.

Alternatives considered:

- Leave status only in PR descriptions and comments.

Evidence:

- `origin/main` at `f581851` does not contain `PROJECT_STATE.md`, `NEEDS_USER.md`, or `docs/DECISIONS.md`.
