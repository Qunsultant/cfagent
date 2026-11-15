### Changed
- Flipped `POST /payments/agentic/commercial/submission/check-payment` in `src/agents/routes/agenticPayments.ts` to return `404` (`FAILURE_COMMERCIAL_NOT_FOUND`) for unknown submissions instead of falling through to the legacy unrecorded verify path, matching `submission-status`, and seeded paid submissions in `tests/commercial_checkout_ui_routes.test.ts` (#4606).
