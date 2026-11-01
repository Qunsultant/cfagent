## [2657] Referral credits: durable attribution + automatic earn

Referral-credit ledger already exists via #2208; this slice adds only the
missing layer it named as follow-up: a set-once referrer→referred
attribution store (migration 0031), an operator attribution route, and
automatic earn on a referred user's first verified paid submit
(monetization-ON path only, best-effort, audited). Subscription redemption
stays deferred (acceptance reads pay-per-use and/or subscription).
