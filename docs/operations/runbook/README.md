# System runbooks

`docs/operations/runbook/` is the home for system runbooks going forward.
A runbook is an operator procedure: what runs, what gates it, how to
pause it, and how to recover when something goes wrong. New runbooks
belong here; existing runbooks move here in follow-up PRs (see below),
not in bulk, so each move stays a reviewable pure rename.

## Current runbooks

| Runbook | Location today | Status |
| --- | --- | --- |
| Screening System Runbook (operator runbook for the goal/scenario screening system, Epic #1096 Phase 6) | `docs/operations/runbook/screening-system-runbook.md` | Current |
| Stuck Runs Runbook (detection, diagnosis, and safe intervention for long-running async job runs, issue #2567) | `docs/operations/runbook/stuck-runs.md` | Current |
| Service Identity Operator Runbook (operator runbook for the service-identity configuration) | `docs/architecture/security/service-identity.md` | Current — candidate to move here |

## Missing

- Standalone rollout runbook referenced by
  `docs/architecture/business/system-overview.md` (mentions a runbook
  as a rollout artifact; no standalone doc exists). To be written, not
  just moved.

## Not runbooks (name-search false positives)

- `changelog.d/1864-web-submit-runbook.md` is a changelog fragment,
  not a runbook.
- Mentions of the word "runbook" in `docs/agents/tech-standards.md`,
  `docs/agentic-org/*.md`, and `docs/agents/*.md` are references to
  runbooks as a category, not runbooks themselves.
