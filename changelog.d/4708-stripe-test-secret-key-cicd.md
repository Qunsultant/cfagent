### Added
- Wired `STRIPE_TEST_SECRET_KEY` (and `STRIPE_LIVE_SECRET_KEY`) through `.github/workflows/deploy.yml` (`Set Payment Gateway secrets on Cloudflare Worker`), `wrangler.jsonc` (`"keep_vars": true` and `_comment_stripe`), `src/types.ts`, and `StripePaymentStrategy.resolveApiKey` (`src/patterns/paymentStrategies.ts`) (#4708).
