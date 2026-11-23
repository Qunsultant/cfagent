### Fixed

- Opportunity Hunt now runs end to end from the Stock Hub panel (issue 6293): the `POST /api/opportunity-hunt/run` seam is immediate instead of queued as an async job behind a 10-minute poll, so the panel gets the hunt's result synchronously as the route was designed — no more orphaned or never-completing jobs with no output shown.
- The hunt panel reports a 408/500 poll outcome structurally (catalog message + job id + run-ledger link) instead of rendering the raw transport text, and shows a running status line with elapsed time while a run is pending.
- A goal trigger that evaluates no goal now answers 404 instead of `{ok: true}` with 200, and the run ledger reports what the tick actually says (started / skipped / failed) instead of a canned "run started".
- A run whose ledger record does not land is now a tick error instead of a silent success, so a trigger can never again look successful while the ledger shows nothing.
- `cronToEnglish` renders stepped hours ("0 */6 * * *" → "Every 6 hours at :00") and never renders NaN for unparseable fields.
