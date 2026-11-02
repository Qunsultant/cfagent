### Fixed

- **Saga progress no longer 404s on a just-started run (Qunsultant/cfagent#2777):** the status route falls back to the synchronously-written projection row (tenant-scoped, same read as job history) until audit rows land; panel polling treats 404 as "not yet" instead of stopping; the receipt renders no URL at all (split scope — the Workflow Runs link ships later with the Workflow Runs extension follow-up, once saga runs appear in that view).
