### Changed

- **§11 names the flip mechanism (#4495):** the enrollment paragraph now records that a draft is flipped with `markPullRequestReadyForReview` (GraphQL), that the REST `POST /pulls/{n}/ready_for_review` answers 404 on this repo, and that a flip which leaves the PR a draft fails the run. #autoclaw-001
