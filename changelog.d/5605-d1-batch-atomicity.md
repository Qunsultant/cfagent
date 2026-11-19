### Changed

- **D1 batch atomicity (#5605):** the four multi-write routes now apply their D1 statements as one batch through the existing `d1BatchTransactionBackend` / `withTransaction` leg — journal posts (one batch per post), the subscription activation/grant pair (subscription row + account upsert), tenant settings PATCH (up to three settings upserts), and bulk moves (one batch per customer move). A failing statement leaves no partial state; success-path outcomes are unchanged. No new transaction mechanism; the DO leg is untouched.
