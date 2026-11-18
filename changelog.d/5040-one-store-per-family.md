### Changed

- **Data model (#5040):** Recorded and pinned the canonical store home per family (H-3 `mas_reports` DO + `agent_reports` projection, H-4 `unified_schedules`, H-5 `mas_transactions` with KV `payments` retired, H-6 `reportBlobStore`, D-14 no `kv_namespaces` in `wrangler.jsonc`) in `docs/architecture/data/data-model.md` §5 and `tests/one_store_per_family_5040.test.ts`.
