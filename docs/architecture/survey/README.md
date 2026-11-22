# Survey index — `docs/architecture/survey/` (CISO lane)

This directory is the repo's single home for survey documents: a standalone
inventory, assessment, scan, or gap survey of a system surface, copied here
verbatim as a dated snapshot. Each lane files its own surveys here; the
workspace originals stay as-is (copy, not move). Other files in this
directory belong to their owning lanes — see the directory listing.

## Filed by this lane (#CISO-bhdm)

| File | Source | Description |
|---|---|---|
| `sechub-api-mcp-inventory-2026-11-15.md` | CISO lane working file (copy) | SecHub API/MCP inventory for the security-agent build (#3114): what the PDP/PEP/PIP/PAP tabs expose, the REST routes behind them, and the absence of any SecHub MCP tool. Verified against main `fcd96a2f`, 2026-11-15. |

## Filed by this lane (#cfo-qunso)

| File | Source | Description |
|---|---|---|
| `6056-job-run-tables-rationalization-survey.md` | CFO lane working file (copy) | Why so many job/run tables: full inventory of 63 stores holding job/run records (29 DO-SQLite + 31 D1 + 2 KV halves + 1 R2 bucket), trade-offs, and the one-table recommendation (#6056, under #3123). Verified against main `e7101819c`, 2026-11-21. |
| `6005-run-logging-research-survey.md` | CFO lane working file (copy) | Where Autopilot stores its job outcomes (`mas_job_outcomes`, DO-SQLite), why Autopilot is not on the J-stack for its own logging, and why the runs view is not one source today (#6005–#6008). Verified against main `dc021d3e`, 2026-11-21. |
| `3550-jstack-fit-gap-inventory-survey.md` | CFO lane working file (copy) | J-stack fit/gap inventory for ALL screening capabilities + ALL workflow families (#3550): verdict NOT READY, 22 shared engine-core prep gaps. Verified against main `817a5218`, 2026-11-10. |
| `3550-stock-screener-jstack-inventory-survey.md` | CFO lane working file (copy) | Stock screener → J-stack inventory, lossless/additive (#3550). Verified against main `817a5218`, 2026-11-10. |
| `3550-options-screener-jstack-inventory-survey.md` | CFO lane working file (copy) | Options screener → J-stack capability/gap inventory (#3550). Verified against main `817a5218`, 2026-11-10. |
| `3460-broker-provider-neutrality-inventory-survey.md` | CFO lane working file (copy) | Platform-wide broker/provider neutrality inventory: surfaces that assume a broker or provider (#3460). Verified against main `4839f9e6`, 2026-11-07. |
| `2528-options-screening-inventory-survey.md` | CFO lane working file (copy) | Options-screening inventory, code only (#2528). Main `97ae8a39`, 2026-10-31. |
| `stock-screen-gap-issue-map-2026-11-13-survey.md` | CFO lane working file (copy) | Stock-screen gap → issue map (complete), 2026-11-13. Head `08ccad30`. |
| `2528-options-report-scope-inventory-survey.md` | CFO lane working file (copy) | Report-scope inventory: 6 types / 5 families / 18 artifacts / 7 channels (#2528). Evidence base main `0e368866`, 2026-11-01. |

## Same lane, published elsewhere (indexed, not duplicated)

Per the just-one-of-everything rule, CISO-lane surveys already published at a
canonical location are indexed here, not copied again:

- `docs/compliance/system-duplicates-scan-1717.md` + appendices (a–q) —
  system-wide duplicate/overlap scan, #1717 (owner-directed location:
  `docs/compliance/`).
- `docs/architecture/security/gate-coverage-inventory-1754.md` — gate-coverage
  inventory, #1754.
- `docs/architecture/security/secrets-inventory-and-rotation-policy.md` —
  secrets inventory and rotation policy, #2686 / #768.

## Related (other repo)

- The per-agent non-A2A capability survey (cfpay #260) lives in the cfpay
  repo and is not copied into this tree.

Index created by the CISO lane copy (#CISO-bhdm), 2026-11-16, issue #4800.
