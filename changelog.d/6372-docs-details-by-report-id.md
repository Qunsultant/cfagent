### Docs run details resolve the row the panel names (#6372)

- `/api/runs/details` resolves a canonical row **by its report id** when the merged newest-100 lists do not carry it — the panel fetches by `documents.reportId`, and the lookup previously matched only `runId` / `id` / `scanRunId`, so a row outside the window 404'd by construction.
- The fallback reads the same store the list is built from, under the same owner scope: a missing row stays an honest 404, and another owner's report id does not resolve.
- A miss now carries `ledgerReadMode` in the 404 body (the same field the 200 carries), so a live miss is discriminated on sight — projection vs. read window vs. owner scope — instead of needing a redeploy to tell them apart.
- In `d1-only` mode the DO read is forbidden by the mode, so the projection half stays with #4116 rather than being bypassed here.
