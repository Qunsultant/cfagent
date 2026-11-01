### Added

- **Saga paid-run metering (issue #2041, G-METERING):** saga-originated paid runs now record one `usage_events` row (category `saga`, receipt-scoped id `use_<receiptId>`) after payment confirms, via a new `POST /api/meter/event` route reached endpoint-mediated from the payment workflow; non-saga payment runs are unchanged and meter nothing.
