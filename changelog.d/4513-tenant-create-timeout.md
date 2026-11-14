### Fixed

- Tenant create in Platform Admin now always settles with a plain outcome: a success notice naming the created tenant, or a failure notice — including a timeout message when the request never returns — instead of spinning forever with no message (#4513). Tenant administration calls opt into a 30-second per-request bound in `apiFetch`; other callers are unchanged.
