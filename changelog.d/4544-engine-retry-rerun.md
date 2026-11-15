### Engine retry no longer masks a failed forced rerun (#4544)

- A forced stage re-run that fails mid-execution now re-executes from step 0 on retry, instead of resuming past the dispatch's recorded step artifacts and reporting `completed` on replayed output. The retry re-derivation honors the same rule as the unit's starting position: forced units restart, every other retry keeps deriving (a fresh run resumes from what its own first try persisted; a resumed run derives from the persisted hand-offs). Engine-level, all families and both pacings.
- Survey verdict, recorded in code: uncoded throws stay retryable — a transient failure such as the gateway's "temporarily unavailable" names retry as its own remedy, and the second attempt after backoff is the retry budget working as designed.
