### Observability

- **API requests now carry the validated execution context (#6172):** every API route handler receives the one shared `resolvePlatformContext` resolution, resolved once per request at the fetch boundary and carried unchanged through the request — the `http.request` log event and the SLO recorder name the context's tenant, dispatch mode, exec mode, and environment instead of null identity fields. Unresolvable contexts are denied with a named, audited code (observe mode proceeds unattributed; enforce mode refuses with 403 before any route runs).
