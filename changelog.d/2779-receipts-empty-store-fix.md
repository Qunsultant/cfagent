### Fixed

- [#2779] GET /api/payments/receipts no longer 500s on stores with no
  usage_events table: the receipts read path now ensures the table via
  the usage port's ensureSchema before the SELECT, so a zero-receipt
  account gets 200 + an empty list. Receipts read failures now return
  the typed ReceiptsUnavailable 500 instead of raw store error text.
