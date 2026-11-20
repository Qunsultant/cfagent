### Added

- Usage metering rows now carry the account tenant (#3185 stamp slice): `usage_events` gains a nullable `tenant_id` column plus the `idx_usage_events_tenant` index, stamped from `getAccount(login).tenantId` at event time (saga threads the validated tenant; research run/evaluation and the subscription-covered call resolve it via one indexed D1 read; anonymous x402/MPP rows stay NULL). Legacy rows stay NULL, never invented; a `listByTenant` reader is added on the usage port. The cross-DO bridge is a follow-up slice, not this one.
