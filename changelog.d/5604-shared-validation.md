### Changed

- **Shared request validation (#5604):** platform routes (accounts, tenants, channels) and the audit strict-write validator now validate request shapes through one shared zod helper (`src/api/requestValidation.ts`); malformed requests get coded 400s (`FAILURE_COMMERCIAL_REQUEST_INVALID`) with the existing messages, and a non-object body maps to the coded 400 instead of a 500.
