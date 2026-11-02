### Added

- Agent access management (#2171): stable agent identities
  (`agent:<kind>:<slug>`), exact-match grants (tool / route /
  agent / data, tenant + purpose + resource scope + budget +
  expiry), PDP-seam enforcement with fail-closed PDP errors,
  0 ms revocation propagation per trigger class, and uniform
  `agent.action` audit records (agent + grant + delegating
  principal). MCP gate + agent-turn adapter enforcement is opt-in
  per call site behind the platform-only `IAAA_AGENT_ACCESS_MODE`
  switch (default `off`; `audit` shadows, `enforce` denies) —
  no live behavior change at merge. A2A dispatch is unchanged.
