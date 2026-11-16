### Fixed

- **Operator-created products appear in the product catalog (#4696):** the
  catalog table (`?tab=product-hub&view=products`) now lists one row per
  created subscription product — the effective version for the default
  segment, priced only when its price is approved (`$1.00 / 30 days —
  approved plan price`, purchase through the Selling tab); unapproved or
  version-less products appear unlisted with a named reason. Per-run family
  rows are unchanged. No flow, money, approval, or access change.
