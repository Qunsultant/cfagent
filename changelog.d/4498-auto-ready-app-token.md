### Fixed

- **The flip gets the credential it needs (#4498):** `markPullRequestReadyForReview` answers FORBIDDEN ("Resource not accessible by integration") to the workflow token — the same constraint the queue call has — so the ready half could never flip, even after #4496 made the failure loud. It now mints the same short-lived GitHub App token the enrollment job uses, and fails with a named error when no token is minted. #autoclaw-001
