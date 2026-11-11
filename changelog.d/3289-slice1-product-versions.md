### Changed

- Product configuration is now versioned (#3289 slice 1): products are identity and plans / catalogue prices are immutable version snapshots with an effective window and a per-customer segment; the gate resolves the effective price for the holder's segment, per-charge journal / ledger / claim rows record the product, version, and price charged, and operators can move one subscription to another version of the same product or assign an account's segment (no UI in this slice; per-run prices stay PROPOSED).
