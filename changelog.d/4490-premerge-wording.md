### Changed

- **Pre-merge checklist: ready means queued, not "auto-merge on" (§9, #4490):** the checklist still told agents to mark a PR ready *with auto-merge on*, which §11 forbids — an auto-merge request records the repository default (SQUASH) and can never merge under the rebase-only ruleset. It now says mark ready and let the enrollment workflow queue it. #autoclaw-001
