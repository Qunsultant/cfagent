### Added
- `#4614`: Added `src/services/tenantCredentialStore.ts` providing a tenant-keyed provider/broker credential store (`InMemoryTenantCredentialStore`, `KvTenantCredentialStore`, `migrateLegacyEnvCredentialsToTenant`, `resolveTenantCredentials`) that prevents cross-tenant credential sharing and stamps `provenanceProviderId`.
