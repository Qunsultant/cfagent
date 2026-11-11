### Engine

- **Retire operation for stages (#3944):** the eighth uniform stage operation — a retired stage never re-runs in any run, and a live run reaching it settles cancelled with the stage named, downstream never proceeding. Addressed like the other seven, by (jobId, nodePath) and by (runId, stageId) on vocabulary stages.
