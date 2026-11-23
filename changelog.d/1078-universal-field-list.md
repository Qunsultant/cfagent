### Security

- **#1078: Validated ExecutionContext carries the universal field list (#1078)** — the contract now carries sessionId, runId, platformId, traceId, dispatchMode (the five JOB_RUN_TRIGGERS modes) and execMode (sync/async) as optional inputs validated fail-closed when present; narrowing inherits them verbatim and can never set or change one. No behavior change for existing call sites: the new fields are optional, and the one shared resolution (#6151) stamps them.
