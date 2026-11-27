### Fixed

- Feed deadline terminal errors now name the legs that consumed the execution budget with per-leg elapsed times, and cumulative retrying legs share the execution budget: the retry gate stops by name when the budget is consumed instead of starting an attempt the deadline race would kill unnamed (#6678).
