### Added

- **EMAIL Email Sending binding (#2889):** `wrangler.jsonc` now declares the `send_email` binding (`EMAIL`), so production outbound mail via the Adapter S4 EmailSender port reaches the real Cloudflare send path instead of the fail-soft `false` path; no change to the fail-soft contract for unbound envs.
