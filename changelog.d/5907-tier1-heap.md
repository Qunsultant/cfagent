### Changed

- **Tier 1 script sets its own Node heap (#5907):** `scripts/verify-tier1.sh` now exports `NODE_OPTIONS=--max-old-space-size=4096` so its typecheck step does not hit JavaScript heap out of memory on machines with Node's default ~2 GB heap. Follow-up to #4082; probe-verified 2026-11-19.
