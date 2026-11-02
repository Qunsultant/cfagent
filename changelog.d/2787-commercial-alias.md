### Fixed

- Bare `/payments/agentic/commercial/*` paths (account, identity, plans, operators, pricing, prices) no longer 404: the `server.ts` dispatcher accepts the bare commercial spelling alongside the canonical `/api` spelling, with identical auth, instance routing, and CORS preflight. The live GoalScreenPanel pricing fetch uses the bare spelling. (#2787)
