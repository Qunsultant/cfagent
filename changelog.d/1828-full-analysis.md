### Added

- `docs/architecture/design-analysis.md` and `docs/architecture/security-analysis.md` recovered from PR #1828 (#3461), which was reviewed and never merged. Each carries a provenance header, an authority rule (code and ADRs win) and the verification actually performed on recovery.
- `docs/architecture/performance-analysis.md` recovered as a **measurement plan** (#3461). The draft's latency figures were generic Cloudflare characteristics presented as measurements of this platform; they are not republished. The plan names what to measure, how to make a figure trustworthy, and the budget facts that are already enforced.

### Changed

- The recovered design report's Durable Object count is corrected to the 18 classes bound in `wrangler.jsonc`, and its `SearchAgent` entry is corrected to `AiSearchAgent` (`src/agents/search.ts` no longer exists; the `SEARCH_AGENT` binding resolves to `OrchestratorAgent`). The screening entry now records that scans compose on the selected broker's chains (#3272/#3388) rather than being E*TRADE-only.

### Not done

- No latency number was invented to replace the draft's. A figure without an environment, a sample size and a date is a guess; the plan says so in the file.
