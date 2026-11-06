### Added
- Publish stage core (#3527 S1): new `src/services/documentPublish.ts` — one `publishDocument` operation composing the existing report index executors (Vectorize canonical index + AI Search items) behind per-target outcomes; the canonical store seams now delegate their fan-out firings to the stage and keep recording `fanout_outcome` from its outcomes, byte-identical to before.
