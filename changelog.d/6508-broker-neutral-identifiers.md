### Broker-neutral names for generic code, with a shrink-only census (#6508)

- **First rename:** `EtradeResearchDataProvider` → `PlatformResearchDataProvider` in `src/services/researchProviders.ts`, with every import, call site, and test updated. The class was already broker-neutral in behaviour (it resolves whichever platform the run selected); the name now says so.
- **Census:** `tests/broker_named_identifier_census_6508.test.ts` scans generic modules for lowercase-t `Etrade*` identifiers. Every survivor is listed with its class; an unlisted symbol fails, and a vanished symbol must be removed from the allowlist — it only shrinks. Broker-scoped adapter paths are excluded.
- **Standard:** H7 in `docs/architecture/code/08-deprecation-changelog-docs.md` now states the identifier rule and names the census as its enforcement point.
- **Follow-up:** #6514 owns the separate capital-t `ETrade*` platform-service family (Browser/Email/Webhook/Payment/Fibers), which the census deliberately excludes until those generic services are separated from genuinely broker-scoped types.
- No behaviour change; the research suites and the neutrality pin stay green.
