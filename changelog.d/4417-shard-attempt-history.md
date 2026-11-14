### Added

- **Per-shard attempt history is persisted and shown (#4417):** `withRetry` gains an `onAttempt` hook fired on every failed attempt (including the terminal one, and never able to mask the retry's own error), and the shard executor records each attempt — number, error text, instant — into a probed `attempts_json` column on the async job row, so the history survives a host restart. The run detail shows `Attempts N: #1 … · #2 …` on the shard's stage; a shard that never retried reads zero attempts, not an absent history. #autoclaw-001
