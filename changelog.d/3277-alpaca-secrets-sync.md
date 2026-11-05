### Added

- **Alpaca dual-mode secret sync on Cloudflare Worker (#3277 S3):** `.github/workflows/deploy.yml` pushes the seven Alpaca secrets (`ALPACA_LIVE_API_KEY`, `ALPACA_LIVE_SECRET_KEY`, `ALPACA_LIVE_URL`, `ALPACA_MARKET_URL`, `ALPACA_PAPER_API_KEY`, `ALPACA_PAPER_SECRET_KEY`, `ALPACA_PAPER_URL`) to Cloudflare Workers via `put-secret.sh` during the secret sync phase. Pinned in `tests/deploy_workflow_secret_retry.test.ts`. #ceo-aimp
