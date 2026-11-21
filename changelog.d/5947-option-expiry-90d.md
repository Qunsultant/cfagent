### Fixed

- **Option expiry fixtures now fully run-time-relative (#5947 follow-up):** the first fix used a 30-day relative expiry and a fixed 2027-02-01 chains date; per the standing rule that fixture dates are never static, all eight files now compute the expiry from the current date + 90 days, so the fix never goes stale. #CDO-mha7
