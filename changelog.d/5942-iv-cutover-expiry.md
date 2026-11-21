### Fixed

- **The one expired option fixture #5947's sweep missed (#5942):** `tests/options_discovery_iv_cutover_wiring_2337.test.ts` still pinned `expiryDate: "2026-11-20"`, the past date the #5947 sweep removed from every other option fixture. It now derives from now (+30 days), so it cannot age out and needs no future sweep. Fixture only — no production code change. #ceo-aimp
