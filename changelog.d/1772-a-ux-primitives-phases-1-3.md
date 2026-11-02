### Added

- **UX primitives exceptions pin (#1772 phases 1–3, parent #1717):** re-audit of the 44 exception files in `docs/architecture/UX/exceptions-01.md` (28 zero-primitive + 16 partial) against current main shows all 44 already render zero raw controls and import a ui primitive, so phases 1–3 close as verified-done with a named 44-file pin test (`tests/ux_primitives_exceptions_1772.test.ts`) instead of rebuilt; verification record at `docs/architecture/security/ux-primitives-1772-verification.md`. No production behavior changes in this slice.
