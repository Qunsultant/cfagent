# Broker parity matrix

Issue #4038 / #4039. One row per capability, one column per broker. Every cell
is exactly one of:

- **parity** — the capability exists on the platform and has a conformance test;
- **impossible (reason)** — the broker cannot provide it; the reason is evidence
  (a missing tool, a documented absence, a mode the broker does not have);
- **live-only (reason)** — it exists but only in live mode;
- **—** — not a platform capability (data-plane rows served by data providers).

The pin `tests/broker_parity_matrix_4038.test.ts` reads this table and checks it
against the platform prototypes: a `parity` cell must be a real method, and an
`impossible` cell must be absent (a stub that returns empty data is a lie, not a
gap). Change the code, change this table in the same PR.

| Capability | E*TRADE | Alpaca | Public.com |
|---|---|---|---|
| Quotes | parity | parity | parity |
| Options chains + expiries | parity | parity | parity |
| Accounts | parity | parity | parity |
| Positions | parity | parity | parity |
| Position lots | parity | parity | impossible (the hosted MCP surface exposes no lot-level position read) |
| Order preview | parity | parity | parity |
| Order placement | parity | parity | live-only (Public has no paper mode; TEST refuses with FAILURE_PUBLIC_NO_PAPER_MODE) |
| Order cancel | parity | parity | parity |
| Order history / activity | parity | parity | parity |
| Watchlists | parity | parity | impossible (no watchlist tools on the hosted MCP surface) |
| Session orders (pre/post/EXTO) | impossible (no session terms on the wire) | parity | impossible (no session terms on the hosted MCP surface) |
| Historical bars | — | — | — |
| Fundamentals | — | — | — |

## Data-plane rows

Historical bars and fundamentals are served by the registered data providers,
not by the broker platforms: etrade/public declare quotes + optionsChains,
yahoo declares quotes + historicalBars + fundamentals, nasdaq screenUniverse,
alpaca quotes + historicalBars + fundamentals. A tenant whose selected provider
cannot serve a capability is served by a capable provider with the substitution
recorded (`requestedDataProviderId`, #4014).
