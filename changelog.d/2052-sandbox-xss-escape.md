### Security

- **Sandbox terminal XSS fix (#2052):** the public `/checkout/sandbox` page now HTML-escapes all five interpolated query params (provider, customer, amount, currency, sig) and sends a `Content-Security-Policy` header (`default-src 'none'; style-src 'unsafe-inline'; base-uri 'none'; frame-ancestors 'none'`). The route stays public by owner decision 2026-11-01 (KEEP PUBLIC); the Authorize href keeps `encodeURIComponent` URL encoding. Pinned by `tests/checkout_sandbox_xss_2052.test.ts`.
