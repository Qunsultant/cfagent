### A run's checkpoints are visible, per stage (#6377)

- The Workflow Runs run detail now shows each stage's **checkpoint entry** — unit states, attempts, recorded start/end, the result reference each step returned, and the resume position a stopped unit continues from — in one collapsible per stage (the existing `ui/` Disclosure primitive).
- No new route and no new store: the entry rides the stage read the page already makes (`projectStageViews` → `stagesFromEngineViews`), so a stage's state and its checkpoint cannot disagree.
- A run with no checkpoint says so instead of rendering an empty panel, and a stage read that is **not** the checkpoint (the research ledger read, which keeps the checkpoint only as a fallback) claims no checkpoint rather than dressing ledger rows as one.
- Artifact keys stay where they already are — the run's "Artifacts & delivery" section. The checkpoint carries each step's result reference, not artifact-store keys, and the viewer never invents one.
