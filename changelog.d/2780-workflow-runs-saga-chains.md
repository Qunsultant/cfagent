### Workflow Runs

- **Saga chains now appear in Workflow Runs** — projection chains with jobKey `saga` are listed as goal-family runs with stages from their saga audit rows (projection submitted stage before audit rows exist), owner-scoped to the session user, and the Goal Screen receipt links to the run via the Workflow Runs view instead of a raw status URL (Qunsultant/cfagent#2780).
- **Saga audit failures degrade visibly in Workflow Runs** — a failed saga audit or projection read is named in `storeErrors` and never hides the other runs (Qunsultant/cfagent#2780).
