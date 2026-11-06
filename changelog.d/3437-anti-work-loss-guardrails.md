### Added

- **Anti-work-loss GitOps guardrail (#3437):**
  - Added `scripts/ci/verify_pr_closure.py` and `scripts/verify-superseded.sh` to enforce the "Diff-Before-Close" rule.
  - Mandated that no PR or branch may be closed as "superseded" or "duplicate" if it contains unmerged functional differences against `origin/main`.
  - Added test coverage in `tests/safe_pr_closure_workflow.test.ts`.
  - Updated `docs/agents/gitops.md` (§11, §24) and `AGENTS.md` with anti-work-loss policy, single-lease issue claiming, and the delta harvest protocol.

