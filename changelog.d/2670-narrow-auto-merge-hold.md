### Changed

- **Auto-merge hold removed (#2670, owner decision 2026-11-01, superseding the narrowing decision):** `auto-merge-trusted.yml` no longer withholds auto-merge for any reason. All green PRs auto-merge via the bot + merge queue, including bot-authored, Jules-created, and workflow-touching PRs. Remaining safety net: required checks (Policy Gate including its no-deletion rule, Gitleaks, Test & Build, Load Active Environment) plus merge-queue validation.

## Agent #CISO-bhdm

Closes #2670

Process documentation impact: scope documented in the workflow header comments.
