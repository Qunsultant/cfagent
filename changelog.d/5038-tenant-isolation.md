### Changed

- **Data model (#5038):** Recorded the tenant-isolation boundary decisions (G-1 deployment-level substrate, G-6 per-DO-instance `mas_events`, G-7 deployment-scoped pipeline host tables + tenant-scoped `agent_async_jobs`, H-7 shared auth-substrate `SessionStore` behind server-side PEP gates) in `docs/architecture/data/data-model.md` §5 and pinned them in `tests/tenant_isolation_5038.test.ts`.
