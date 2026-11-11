### Changed

- **Observability moved to its lowest recording setting (#4131).** `head_sampling_rate` 1 → `0.01` (Cloudflare's floor, 1% of invocations), `logs.head_sampling_rate` 1 → `0.01`, and `logs.persist: false` so samples stream without being stored. `enabled: false` remains the only lower step and is not taken.
- **`MAS_MAX_STEPS` 2 → 5.** The loop cap set in #4128 was too tight for a real goal; five steps is the owner-directed value.
