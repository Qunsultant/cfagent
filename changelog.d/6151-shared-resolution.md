### Platform

- **One shared context resolution (#6151):** `resolvePlatformContext` composes the per-concern resolvers (identity, broker, screen provider, run broker) into the single Validated ExecutionContext, resolved once per session with fail-closed denials; a census pin fails any other file that calls a per-concern resolver directly.
