### A research run is a workflow run, not an "Options" Docs row (#6371)

- Report-only research runs now take their engine family from the canonical source (`options_research` → `research`) instead of the Docs artifact family (`options`), so the one ledger stamps `ledgerKind: "workflow"` and the run is visible under the Workflow Runs filter — with its stages addressable.
- The Docs family is untouched: a research row still files its artifacts where it did, and every other family keeps its kind (options screen → options, strategy → discovery).
- Interim decision recorded on the issue: re-kind the report-only research run, rather than widening the filter — the run *is* a research engine job, and widening the filter would mislabel real options rows.
