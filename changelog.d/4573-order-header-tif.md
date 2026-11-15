### Changed

- Single-line ticket header (#4573): `CardHeader`/`WorkCard` gain a `singleLine` mode (a `ui-card-header-single` primitive rule), so the ticket's title, scope note, broker/mode badges and Refresh Quote compose on one row, with long text ellipsizing instead of wrapping.
- Time-in-force and the per-broker order matrix (#4573): `config/order-capabilities.json` is the one table of order types and time-in-force per broker, mode and asset class. The ticket offers exactly what it lists and disables the rest; the preview body always carries `timeInForce`, and `buildOrderPreviewBody` refuses a combination the matrix does not list before any request is sent.
