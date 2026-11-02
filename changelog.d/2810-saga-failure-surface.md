### Fixed

- **Saga failures now surface with step + reason instead of dying silently** — an uncaught leg error ends the saga as a recorded FAILURE_SAGA_FAILED (saga.failed row with leg + real reason text, Slack outcome notice, saga.ended); leg-child error text (e.g. the fail-closed price message) propagates as the reason, not just a code; the status route surfaces instanceError for errored instances, and the panel renders errored as a terminal failure state and stops polling (Qunsultant/cfagent#2810)
