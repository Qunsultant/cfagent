### Added

- Public REST rate limiting (#1774, F-55): `API_INGRESS_MODE=unified` now caps `/api/*` traffic at 300 requests / 60s per connecting IP (`src/api/ingress.ts` `checkPublicRestThrottle`, wired at the `handleFetch` choke point in `src/server.ts`); legacy mode keeps the current uncapped behavior, and non-`/api/*` paths are untouched. Pinned by `tests/public_rest_throttle_1774.test.ts`. Production activation is an owner action (env value); this slice sets no production switch value.
