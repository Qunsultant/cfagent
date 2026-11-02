### Added

- [#2658] Tier-gated ads verification pins: store-path PayPerUse
  serving, 2.1 Billing-shaped subscription suppression, the composed
  Subscribed display contract, tenant-off beating a live
  subscription, and Free served by default on both lists
  (tests/ads_tier_gated_surfaces_2658.test.ts). No production
  behavior changed: the #2022 server-side enforcement already
  satisfied the acceptance line on every gated surface.
