### Changed

- Enable Flagship `monetization` feature flag (#2742, owner direction): `CfFlagshipAdapter` now supplies a `true` (ON) provider default when querying Cloudflare Flagship bindings (`env.FLAGS`) for `monetization`, activating PaymentWorkflow charging and monetization gating while preserving fail-closed semantics on provider errors and respecting explicit dashboard overrides. Added `FEATURE_MONETIZATION: "1"` to `wrangler.jsonc` `vars` for runtime environments without native Flagship bindings. Pinned by `tests/feature-flags-port-conformance.test.ts`.

