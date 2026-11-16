### Changed
- `#4617`: Required non-null `userLogin` on every new `mas_data_captures` row via `resolveCaptureUserLogin()` in `src/data/providerCapturePorts.ts` and `insertCaptureRow()` in `src/data/doSqliteProviderCaptureAdapter.ts` (explicit user -> tenant scope -> `"system"` for unattributed background jobs).
