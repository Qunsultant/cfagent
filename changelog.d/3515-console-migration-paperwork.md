### Standards conformance
- **Move stale trading ceilings to MIGRATED_ZERO (#3515)** — the final console-migration paperwork batch: `src/trading/channels/intake.ts` and `src/trading/options/unifiedOptionsService.ts` each hold zero real `console.*` uses, so their ceilings (3 and 1) move to MIGRATED_ZERO with no production code change; the ratchet now reads 2, the sanctioned fallback only.
