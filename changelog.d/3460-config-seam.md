### Screens

- **Provider-connection configuration seam** — one validated screen selection (provider connection, external account, environment) resolved server-side from tenant-scoped configuration, with no default broker and no fail-open; unconfigured, store-unavailable, unbound, or cross-tenant selections refuse with a named error, and screen runs carry a validated #1069 §8 `ExecutionContext` (Qunsultant/cfagent#3460).
