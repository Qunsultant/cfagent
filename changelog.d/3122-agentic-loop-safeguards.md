### Added

- **Bounded agentic schedule goals (#3122):** Agentic loops now require owner-managed per-login bounds and a kill switch. Provider-reported token usage is checked during execution; unavailable settings or usage stop the loop, and reaching the token cap requires approval before a bounded continuation. Server-authored loop identity prevents self-rearming without approval and blocks nested-loop triggers. Deterministic schedule behavior is unchanged.
