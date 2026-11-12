### Fixed

- **Auto-merge enrollment is a queue entry, attempted when CI finishes (#4305, #4313):** GitHub records an auto-merge request as the repository default method — SQUASH here, which a rebase-only ruleset cannot merge — even when the mutation asks for `mergeMethod: REBASE`. Verified on a live PR: the request came back SQUASH and the PR sat green, CLEAN and unmerged (#4267, #4219, #4244, #4283, #4285, #4297, #4303). The trusted workflow now enrolls with `enqueuePullRequest` and reads the entry back; it creates no auto-merge request at all.
- **Two triggers, no duplicate run (#4299):** `pull_request` only labels — it no longer re-triggers itself by adding the `labeled` event's label (the duplicate run seen 14 seconds apart on #4299). The enqueue hangs off `workflow_run` on CI completion, because an enqueue at `opened` is rejected while required checks are still running and no later pull_request event fires. The enqueue resolves the PR by head branch and only for PRs carrying the `auto-merge` label.
- **No privileged trigger:** the labelling job uses plain `pull_request` with a same-repo guard instead of `pull_request_target`, which GitHub restricts on public repositories from 2026-12-02 (#4313). The app token is gone; the workflow's own scoped token labels and enqueues. #autoclaw-001
- **The enqueue resolves the PR by the right field (#4305):** gh pr list --json exposes the pull request's node id as id, not 
odeId; asking for 
odeId fails the job outright, which the first live run after merge showed. The field is now id, and the pin fails if 
odeId returns.
