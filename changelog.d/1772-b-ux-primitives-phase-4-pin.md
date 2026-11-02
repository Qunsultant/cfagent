### Added

- **UX primitives Phase 4 CI pin negative test (#1772, parent #1717):** permanent negative test (`tests/ux_primitives_pin_negative_1772.test.ts`) proving the #1580 freeze pin flags a new raw-control file outside `src/client/components/ui/` (including nested files and regressions in previously clean files) while the freeze allowlist stays empty; complements the phases 1–3 44-file pin. No production behavior changes in this slice.
