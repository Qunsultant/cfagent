### Changed
- `#4618`: Included `tenantId` in `tokenCacheKey(envName, userLogin, tenantId)` and tenant-scoped `invalidateTokenCacheFor(userLogin, tenantId)` in `src/security/etradeTokenCache.ts` so no two tenants can share a provider token cache entry.
