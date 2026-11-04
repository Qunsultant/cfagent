### Added

- Session values settled for #945 Q5 (#3113): 7-day sliding absolute TTL,
  2-day renew window, 30-day lifetime cap, 7-day cookie Max-Age, 8-hour
  idle window (operator override clamped to 5 min–7 days), 300 s touch
  interval, 60 s/10 s session-cache TTLs, 10-min OAuth state, 8 cookie
  candidates, per-user cap 10 (from #2840) — recorded in
  `docs/architecture/security/session-values-3113.md` with pin tests.
- CSRF double-submit protection for cookie-authenticated mutations:
  `csrf_token` cookie minted at login, `X-CSRF-Token` header required on
  state-changing requests carrying a session cookie (403 `csrf_invalid`
  otherwise), with exemptions for auth, webhook, MCP/A2A, and Slack paths.
- Session rotation on privilege change: after a successful role/membership
  grant or revoke (8 trigger sites), the affected user's active sessions
  rotate with expiry and auth time preserved; unavailable listing surfaces
  instead of silently skipping.
