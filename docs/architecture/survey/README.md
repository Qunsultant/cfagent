# Survey index — `docs/architecture/survey/` (CISO lane)

This directory is the repo's single home for survey documents: a standalone
inventory, assessment, scan, or gap survey of a system surface, copied here
verbatim as a dated snapshot. Each lane files its own surveys here; the
workspace originals stay as-is (copy, not move). Other files in this
directory belong to their owning lanes — see the directory listing.

## Filed by this lane (#CISO-bhdm)

| File | Source | Description |
|---|---|---|
| `sechub-api-mcp-inventory-2026-11-15.md` | CISO lane working file (copy) | SecHub API/MCP inventory for the security-agent build (#3114): what the PDP/PEP/PIP/PAP tabs expose, the REST routes behind them, and the absence of any SecHub MCP tool. Verified against main `fcd96a2f`, 2026-11-15. |

## Same lane, published elsewhere (indexed, not duplicated)

Per the just-one-of-everything rule, CISO-lane surveys already published at a
canonical location are indexed here, not copied again:

- `docs/compliance/system-duplicates-scan-1717.md` + appendices (a–q) —
  system-wide duplicate/overlap scan, #1717 (owner-directed location:
  `docs/compliance/`).
- `docs/architecture/security/gate-coverage-inventory-1754.md` — gate-coverage
  inventory, #1754.
- `docs/architecture/security/secrets-inventory-and-rotation-policy.md` —
  secrets inventory and rotation policy, #2686 / #768.

## Related (other repo)

- The per-agent non-A2A capability survey (cfpay #260) lives in the cfpay
  repo and is not copied into this tree.

Index created by the CISO lane copy (#CISO-bhdm), 2026-11-16, issue #4800.
