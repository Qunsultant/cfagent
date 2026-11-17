### Changed
- Verify Public.com hosted MCP `place_order` and `preflight_order` live `inputSchema` (run 44069065913): wire `time_in_force` through `publicSingleLegArgs` and `PublicTradingPlatform` for `day`/`gtc`/`ioc`/`fok`, keep `gtd`/`opg`/trailing stops refused, and update `docs/architecture/business/brokerage-data-matrix.md` §4 Gap 14 (#4668).
