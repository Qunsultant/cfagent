### Fixed

- **Workflow Runs carries the Docs columns plus a Reports filter (#2786 Part 3)** — every Docs-tab column is accommodated in Workflow Runs (Source, PDF, XLSX, CSV, with Run Type covered by Trigger and Run ID / Run Details already present), and a new Reports filter shows all report-backed runs. See Qunsultant/cfagent#2786.
- **Workflow Runs detail is lossless for canonical-backed runs (Qunsultant/cfagent#2786)** — the detail now also renders the Docs RunDetail sections (request, provenance, lineage, stages, reasons) from the same `/api/runs/details` payload, and report-only runs keep the canonical body's stages where it carries any, instead of an empty stage list.
