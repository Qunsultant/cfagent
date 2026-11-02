# Vendor risk register (#1774, parent #1717, F-55)

First formal vendor-risk register for this system. Vendors below
are included ONLY where repo evidence shows a live integration
(config, code, or workflow); no vendor is listed on assumption.
"Data processed" describes what the integration can touch, not a
claim about what it did touch in any specific transaction.

Review rule: re-assess a vendor on any material change to its
integration (new scopes, new data, new endpoint) and at least
annually. This document is the first formal review; earlier
informal assessments, if any, are not evidenced and are not
claimed here.

| Vendor | Integration (evidence) | Data processed | Risk | Controls in place | Residual |
|---|---|---|---|---|---|
| Cloudflare | Worker hosting, Durable Objects, Vectorize/AI Search (`wrangler.jsonc`, AI Search endpoint), Deploy workflow (`deploy.yml`) | All Worker traffic, DO state, session records | High — platform concentration | Edge TLS, per-isolate stores, audit hash chain; preview-migration discipline per repo AGENTS.md | Platform outage / account compromise remains the top residual; owner-held account controls |
| GitHub | Repository, CI (`ci.yml`), CodeQL (`codeql.yml`), Gitleaks scan, OAuth provider (`GITHUB_CLIENT_ID` in `src/types.ts`) | Source code, CI logs, user logins | High — code + identity | Branch protection, required checks, secret scanning, OAuth (no stored GitHub passwords) | Token/secret exposure via committed code; mitigated by Gitleaks, not eliminated |
| Google | OAuth provider (`GOOGLE_CLIENT_ID` in `src/types.ts`) | User logins (identity only) | Medium | Provider onboarding defaults doc (`iaaa-google-defaults.md`); unknown-provider fail-closed | IdP outage blocks Google sign-in; GitHub provider remains as alternate |
| Slack | Signing secret + bot token (`src/types.ts`), `/slack/events`, `/slack/interactions`, outbound webhooks | Messages, approval cards, clicker identities | Medium | Signature gate (#147: unconfigured = loud 503, bad signature = 401), outbound webhook rate cap, principal-link gating on approvals (#1262) | Slack-app-side interactivity/scopes are an owner action; a misconfigured app breaks delivery, not authorization (gates still fail closed) |
| Stripe | Payment gateway name + webhook verifier (#148) in `src/agents/routes/payments.ts` | Payment metadata, gateway refs (no card data in repo code) | High — financial | HMAC-verified webhook listener, HITL confirm/capture flow, idempotency keys | Live production key mapping is an OWNER secret action (assessment REM-01); until mapped, live Stripe capture is not operational — ledger code only, no live charge in this work |
| x402 | Agentic-payments gateway (`src/payments/ledger.ts`, gateway `x402`) | Micropayment records, agent spend attribution | Medium | BudgetGuard attribution, ledger-of-record `mas_transactions`, fail-loud on unbound ledger owner | Protocol/price volatility; spend bounded by BudgetGuard |
| Alpaca | Broker integration (trading routes, Alpaca-shaped keys history — see #768: exposed keys treated as exposed, owner rotation) | Trading account data, orders | High — financial | Human-approved trade workflow, budget bounds, key rotation on exposure (owner action) | Broker credential exposure history; rotation is owner-owned |
| E*TRADE | Broker integration (E*TRADE routes, OAuth token lifecycle) | Trading account data, orders, tokens | High — financial | Pre-midnight token renewal, session-store observability (#1819 instrumentation), Connect/token actions are OWNER actions under #1066 | Token expiry/renewal failure is a known incident class; this lane never authorizes Connect or deletes `ETRADE_OAUTH_TOKEN*` values |
| Public.com | OAuth client metadata document (#1247, `src/security/publicOAuth.ts`) | Public.com client metadata (public by design) | Low | Metadata document is public capability discovery, no user data | None material |

## Out of scope, honestly

- Sub-processors of the vendors above (e.g. Cloudflare's own
  sub-processors) are not assessed here; that assessment belongs
  to a vendor-review engagement, not this register.
- No vendor is rated "no risk." A blank residual would be a lie;
  every row above names one.

#CISO-bhdm
