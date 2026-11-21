### Changed

- Copilot screen (`run_stock_screen`) with `delivery:"async"` now returns promptly with the run id and a Workflow Runs status link instead of awaiting the workflow; explicit sync and the family default still await unchanged (#5921).
