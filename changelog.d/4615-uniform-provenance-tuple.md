### Added
- `#4615`: Added `src/observability/provenanceTuple.ts` defining the uniform 5-leg `ProvenanceTuple` (`tenantId`, `userId`, `providerId`, `brokerId`, `channel`) and `ProvenanceRecordKind` (`run`, `delivery`, `denial`, `fallback`), wired into `auditRowFromDraft`, `paidStockScreenSeam.ts` (run and 402/409 denial audits), and `scheduledReports.ts` (`r2_body_put_failed` fallback log).
