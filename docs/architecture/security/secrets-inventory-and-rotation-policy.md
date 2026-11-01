# Secrets Inventory and Rotation Policy

**Related:** cfagent #768 (RSI-InfoSec program #764). **Status:** in force on merge.
**Signed:** #CISO-bhdm

> **Names only. No secret value — real, rotated, or historical — appears in this
> document, and none may ever be added to it.** This inventory records secret
> *names*, their purpose, owning surface, where each is set, its rotation
> procedure, its blast radius, and a last-rotated field. It does **not** assert
> that any given name is currently set in any store: presence in a live store
> is a runtime fact that cannot be read from the repository, and this document
> must not be cited as proof that a secret exists or is live. Where a name is
> referenced by code or workflows but its live presence is unverified, the row
> says so.

## Scope and method

Swept 2026-10-25 on main `de2d4cb7` by grep over the sources #768 names:
`wrangler.jsonc`, `.github/workflows/*.yml` (including the `deploy.yml` Worker
secret-sync steps), `docs/agents/gitops.md` §3 material, and `src/` environment
identifiers. Every name found is accounted for below — either as a secret row
or in the "Referenced but not secrets" appendix, so a name is never silently
dropped from the cross-check.

Location note: #768 suggested `docs/agents/secrets-inventory.md` or the repo's
established doc home. This file lives in `docs/architecture/security/` under
the 2026-10-25 durable-docs rule for this lane's `.md` documents.

## 1. Provider API keys

Owner for this class: the human owner (Mubasher), as provider-account holder.
Rotation is an owner action at the provider, then a GitHub-secret update, then
a deploy sync. No lane rotates a provider key on its own authority.

| Name | Purpose / owning surface | Where set | Rotation procedure | Blast radius | Last rotated |
|---|---|---|---|---|---|
| `ET_API_KEY`, `ET_API_SECRET` | E\*TRADE API credential pair referenced by the deploy workflow | GitHub secret → deploy workflow | Revoke/reissue at E\*TRADE → update GitHub secret → deploy sync → verify-after-rotate (§3) | E\*TRADE API access on paths using this pair | Unknown — not recorded before this inventory |
| `ETRADE_API_KEY`, `ETRADE_API_SECRET` | E\*TRADE API credential pair, deploy secret sync | GitHub secret → deploy sync → Worker secret | As above | E\*TRADE API access on paths using this pair | Unknown |
| `ET_PROD_API_KEY`, `ET_PROD_API_SECRET` | E\*TRADE production API credential pair, deploy secret sync | GitHub secret → deploy sync → Worker secret | As above | Production E\*TRADE API access | Unknown |
| `PROD_ET_API_KEY`, `PROD_ET_API_SECRET` | E\*TRADE production API credential pair, deploy secret sync (parallel name to the `ET_PROD_*` pair) | GitHub secret → deploy sync → Worker secret | As above | Production E\*TRADE API access | Unknown |
| `ETRADE_CONSUMER_KEY`, `ETRADE_CONSUMER_SECRET` | E\*TRADE OAuth consumer pair | GitHub secret → deploy sync → Worker secret | Reissue at E\*TRADE → update GitHub secret → deploy sync → verify-after-rotate; user OAuth tokens (§2) must be re-authorized after a consumer rotation | All E\*TRADE OAuth flows | Unknown |
| `ETRADE_ACCOUNT_ID_KEY` | E\*TRADE account-key identifier used by the trading client | Worker env (identifier, not a bearer credential) | Rotate only if E\*TRADE reissues the account key; otherwise N/A | Single-account trading paths that pass an explicit account key | N/A (identifier) |
| `ALPACA_API_KEY`, `ALPACA_API_KEY_ID`, `ALPACA_SECRET_KEY`, `ALPACA_API_SECRET_KEY` | Alpaca API credentials, formerly in local `.agents/mcp_config.json` (see §4). **Not Worker secrets** — absent from the deploy secret sync | Formerly local MCP config only; new values live only at the provider and in any owner-held local env, never in the repo | Revoke at Alpaca → issue new keys → replace any local copy → verify-after-rotate → never commit | Any Alpaca path using the key (local MCP use) | **2026-10-25 — revoked and rotated by the human owner** (owner-confirmed; recorded as an owner action, not a lane action) |

**Consolidation debt (stated, not fixed here):** E\*TRADE has four parallel
key pairs above, and the GitHub/GitHub-App OAuth names have parallel
`GITHUB_*` / `GH_*` forms (§2). This inventory does not assert which parallel
name is live. The owner should confirm the canonical pair per provider and
delete the unused GitHub secrets; until then, rotating a provider key means
rotating every live parallel name for that provider, or the old name stays a
live credential.

## 2. Signing, session, and webhook secrets

Owner for this class: the platform (CISO lane documents, human owner holds the
provider-side counterparts). A signing-secret rotation invalidates outstanding
sessions/tokens by design — schedule it, do not surprise it.

| Name | Purpose / owning surface | Where set | Rotation procedure | Blast radius | Last rotated |
|---|---|---|---|---|---|
| `SESSION_SECRET` | Worker session signing secret | GitHub secret → deploy sync → Worker secret | Generate new → update GitHub secret → deploy sync → all sessions re-issue; verify a fresh login issues and an old session no longer validates | All user sessions | Unknown |
| `DASHBOARD_API_KEY` (GitHub secret name `DASHBOARD_API_KEY_IS_A2A_TOKEN`) | Single shared A2A dispatch token (Bearer / X-API-Key) | GitHub secret → deploy sync → Worker secret | Generate new → update GitHub secret → deploy sync → update every fleet caller → verify old token gets 401 | All A2A dispatch. **Concentration risk, stated:** one shared key, no per-agent tokens today — a leak compromises every A2A caller at once | Unknown |
| `INBOUND_NLQ_WEBHOOK_SECRET` | Inbound NLQ webhook authentication | Worker env | Regenerate → update Worker secret → verify a signed test request passes and an old signature fails | NLQ webhook path | Unknown |
| `OUTBOUND_WEBHOOK_SECRET` | Outbound webhook signing | Worker env | As above, per receiving endpoint | Outbound webhook consumers | Unknown |
| `SLACK_SIGNING_SECRET` | Slack request signature verification | Worker env (Slack app) | Regenerate in Slack app → update Worker secret → verify a Slack event verifies | Slack events path | Unknown |
| `SLACK_BOT_TOKEN` | Slack bot token (posts, file uploads) | Worker env (Slack app) | Regenerate in Slack app → update Worker secret → verify a post succeeds. **Open owner action, tracked in the §6 owner-action record (#1762, 2026-11-01: still pending):** the bot token still lacks the `files:write` scope (Slack `missing_scope`); file posts cannot arrive until the scope is added and the app reinstalled | Slack posting / file delivery | Unknown |
| `SLACK_CLIENT_ID`, `SLACK_CLIENT_SECRET` | Slack OAuth app client pair | Slack app → Worker env | Reissue in Slack app → update Worker secret → verify OAuth flow | Slack OAuth | Unknown |
| `STRIPE_SECRET_KEY` | Stripe API secret | GitHub secret → deploy sync → Worker secret | Roll in Stripe dashboard → update GitHub secret → deploy sync → verify a Stripe call succeeds | Payments paths | Unknown |
| `STRIPE_WEBHOOK_SECRET` | Stripe webhook signature verification | GitHub secret → deploy sync → Worker secret | Roll in Stripe dashboard → update GitHub secret → deploy sync → verify a test event verifies | Stripe webhooks | Unknown |
| `LEMONSQUEEZY_API_KEY` | Lemon Squeezy API key | GitHub secret → deploy sync → Worker secret | Roll at Lemon Squeezy → update GitHub secret → deploy sync → verify | Lemon Squeezy paths | Unknown |
| `LEMONSQUEEZY_WEBHOOK_SECRET` | Lemon Squeezy webhook signature verification | GitHub secret → deploy sync → Worker secret | Roll at Lemon Squeezy → update GitHub secret → deploy sync → verify a test event verifies | Lemon Squeezy webhooks | Unknown |
| `MPP_SECRET_KEY` | Agentic-payments signing key (`agenticPayments.ts`) | GitHub secret → deploy sync → Worker secret (optional secret) | Generate new → update GitHub secret → deploy sync → verify a payment flow signs/verifies | Agentic payments | Unknown |
| `GOOGLE_CLIENT_ID`, `GOOGLE_CLIENT_SECRET` | Google OAuth client pair | GitHub secret → deploy sync → Worker secret | Reissue in Google Cloud → update GitHub secret → deploy sync → verify Google sign-in | Google sign-in | Unknown |
| `GITHUB_CLIENT_ID`, `GITHUB_CLIENT_SECRET` | GitHub OAuth client pair | GitHub secret → deploy sync → Worker secret | Reissue in GitHub App/OAuth app → update GitHub secret → deploy sync → verify GitHub sign-in | GitHub sign-in | Unknown |
| `GH_CLIENT_ID`, `GH_CLIENT_SECRET` | GitHub OAuth client pair, parallel names to `GITHUB_*` | GitHub secret → deploy sync → Worker secret | As above (see consolidation debt, §1) | GitHub sign-in | Unknown |
| `PAYPAL_CLIENT_ID`, `PAYPAL_CLIENT_SECRET` | PayPal OAuth/API client pair | GitHub secret → deploy sync → Worker secret | Reissue at PayPal → update GitHub secret → deploy sync → verify | PayPal paths | Unknown |
| `AUTO_UPDATE_APP_CLIENT_ID` | GitHub App client ID for the auto-update workflow (a **variable**, not a secret) | GitHub Actions variable | N/A — identifier only | None (identifies the App) | N/A |
| `AUTO_UPDATE_APP_PRIVATE_KEY` | GitHub App private key (PEM) for the auto-update workflow; mints narrowly scoped per-run tokens, never a stored long-lived token | GitHub Actions secret (workflow-only, not a Worker secret) | Regenerate in the GitHub App → update the Actions secret → verify the next auto-update run mints a token | Auto-update of PR branches | Unknown |
| `IAAA_BOOTSTRAP_ADMINS` | Bootstrap admin identifier list (IAAA genesis). Not a bearer secret, but credential-equivalent by construction: it names who may bootstrap admin — treat its edits as sensitive | Worker env | Edit list → redeploy → verify admin bootstrap set matches intent | IAAA admin bootstrap | N/A (identifier list) |

**Stored user tokens (not environment secrets):** E\*TRADE user access/refresh
tokens live in Durable Object session/token storage (see the #415 token-storage
migration). Owner: the individual user. Rotation = the user re-authorizes in
the app. Known outstanding item, unchanged by this PR: E\*TRADE token-expiry
recovery (#902) still needs the owner to re-auth in the app.

## 3. Rotation policy

### Cadence

| Class | Cadence | Notes |
|---|---|---|
| Provider API keys (§1) | Every 90 days | Or sooner on any trigger below. Rotate every live parallel name for the provider, not just the canonical one. |
| Signing / session / webhook secrets (§2) | Every 90 days | Schedule: a rotation invalidates outstanding sessions/tokens. |
| OAuth client secrets (§2) | Every 180 days | Or on app-registration change. |
| GitHub App private key | Every 12 months, or on maintainer change | Regenerate in the App; never store a long-lived installation token. |
| Cloudflare API token (`CF_API_TOKEN`) | Every 12 months, or on role change | Least-privilege token; scope it to the account's Workers/D1 use only. |
| Social / publishing tokens (Threads, X) | On provider expiry, or every 90 days | Provider-side expiry governs where it exists. |
| User OAuth tokens (stored) | On expiry, or on user re-auth | No scheduled rotation by any lane. |

`CF_ACCOUNT_ID`, `PAYPAL_ENVIRONMENT`, and the other identifiers in the
appendix are not rotated; they are identifiers and configuration.

### Event-driven triggers (rotate immediately, cadence notwithstanding)

1. **Suspected leak** — any reason to believe a value left its intended store.
2. **Repository exposure** — a secret-scanning hit on a path that is not a
   scoped historical-fingerprint allowlist entry (§5). Rotate first; an
   allowlist entry is never the response to a live value.
3. **Lane / personnel change** — anyone who held a shared secret leaves the
   lane or the project; rotate every shared secret they could have held.
4. **Provider breach notice** — the provider reports a breach affecting the
   credential class.
5. **Anomalous auth failures** — repeated unexpected 401s / signature failures
   that suggest a key changed or was revoked upstream; investigate, then rotate
   if compromise cannot be excluded.

### Procedure template (every rotation)

1. Revoke/reissue at the provider or issuing system first, so the old value
   dies at the source.
2. Update the GitHub secret (or Actions secret / variable, per the row's
   "Where set" column) — never commit a value to the repo.
3. Run the deploy sync (or the workflow that consumes the secret) so the
   Worker / runner picks up the new value.
4. **Verify-after-rotate** (per class):
   - Provider API key: one read-only call (quote/status) succeeds with the new
     key, and the old key is rejected.
   - Session/signing secret: a fresh login/session issues, and an old session
     no longer validates.
   - Webhook secret: a provider test event verifies with the new secret, and
     an old signature fails.
   - OAuth client secret: the sign-in flow completes end to end.
   - GitHub App key: the next auto-update run mints a token successfully.
   - A2A token: a dispatched call succeeds with the new token, and the old
     token gets 401.
5. Confirm the old value is rejected everywhere it was used — a rotation that
   leaves the old value working is not a rotation.
6. Record the new last-rotated date in this document, in the same change as
   the rotation where possible. A rotation without a record will be treated as
   not having happened at the next review.

## 4. The `.agents/mcp_config.json` flag — resolved on the record

This is the flag #768 carried: whether the Alpaca-key-shaped values in the
tracked `.agents/mcp_config.json` were real or placeholders.

- **Shape + usage evidence (2026-10-25):** the file's 4 key entries (2 unique
  values) were high-entropy credential-shaped strings with no placeholder
  token, and the file fed them as environment to a real Alpaca MCP server
  process — a live-credential usage path, not a sample. No value was ever
  tested against a live API (not authorized), so this is shape + usage
  evidence, not proof the keys were live at any moment.
- **Interim owner classification (2026-10-25 10:38 EDT) that placeholders
  applied did not survive verification** and is superseded by the record here.
- **CPO lane cleanup (merged PR #1486, 2026-10-25):** the file was removed
  from tracking and gitignored; the only template under `.agents/` is now
  `.agents/mcp_config.example.json`, which uses obvious `YOUR_*` placeholders.
- **Owner decision (2026-10-25 evening): treat as exposed.** The human owner
  revoked and rotated the Alpaca keys in Alpaca (owner-confirmed
  2026-10-25). **The rotation is recorded here as an owner action, not a
  CISO-lane rotation** — this lane performed no rotation and no live-API test.
- **History:** the values remain in pre-#1486 git history. Revoked keys in
  history are dead credentials once rotation completes. History purge is a
  **separate owner decision, not done and not claimed here**.
- **Going forward:** local MCP configuration must take credentials from
  environment/secrets, never from a committed file. The example file is the
  only template. Any committed credential-shaped value is a §3 trigger-2
  rotation event, not an allowlist candidate.

## 5. Secret-scanning hygiene

Current state on main (2026-11-01, after #1762; verified by reading the
configs AND by running gitleaks v8.24.2 — the version
`.github/workflows/gitleaks.yml` pins — over the full history):

- `.gitleaks.toml` is now **rule-scoped** (#1762, closing the gap this
  section previously stated). The old single global `[allowlist]` — which
  suppressed *every* rule for every file under `tests/` and `docs/` and
  for nine listed commits — is gone. The only rule with an allowlist is
  `generic-api-key`, with three separate entries: paths (`tests/`,
  `docs/`), four historical commits, and two line-scoped regexes (the
  sandbox-PayPal URL literal and the x402 wallet-address fixture
  constant). A different rule's finding in the same file or commit is
  still reported — verified by planted-finding tests: a generic-api-key
  finding in `tests/`/`docs/` is suppressed, while planted
  stripe-access-token and github-pat findings in `tests/` fire, and a
  generic-api-key finding in a non-allowlisted commit fires while the
  same finding in an allowlisted commit does not. The config shape is
  pinned by `tests/gitleaks_allowlist_1762.test.ts`.
- The pre-#1762 global commits list also carried five values that are
  **not commits at all**: they are `.gitleaksignore` fingerprints, and
  `git cat-file` fails for all five in the repo's full history, so as
  commits entries they suppressed nothing. #1762 drops those five dead
  entries and keeps only the four entries that resolve as commits and
  carry only generic-api-key findings. Dropping a dead entry changes no
  scan outcome; it removes a false claim that nine commits were covered.
- Full-history scan result with the rule-scoped config (2026-11-01,
  gitleaks v8.24.2, `gitleaks git`, 4,553 commits): **no leaks found** —
  the same result as the pre-#1762 global config, so the tightening
  surfaces no previously hidden historical finding.
- `.gitleaksignore` retains 30 fingerprint entries, all `generic-api-key`
  (including three for the historical `.agents/mcp_config.json`
  findings). Those entries are fingerprint + file + rule + line scoped:
  that is the tight form, and it is the only form a historical entry
  may take.

**Rule for any new allowlist entry:** path + rule + fingerprint scoped, never
blanket, never for a live value, never for a value whose rotation is
unrecorded. A new entry requires the same-PR record of what it covers and why
it is historical or a fixture. Test fixtures and documentation samples use
obvious placeholder tokens (`YOUR_*`, `example`, `test`) so they never need an
allowlist entry for a credential-shaped value.

## 6. Maintenance

- Update this document in the same PR as any secret added, removed, or
  rotated, where the change is repo-visible. Rotations whose only record is a
  provider dashboard must still be recorded here promptly by the rotating
  party.
- Review this inventory quarterly, and after any trigger event. The review
  checks: every row still has an owner and a procedure; last-rotated dates are
  within cadence or carry a recorded exception; no row's "Where set" column
  has drifted from the deploy sync.
- The `Last rotated: Unknown` baseline above is honest, not a gap to hide:
  the first cadence cycle after this inventory runs from its merge date, and
  the first quarterly review must replace every `Unknown` with a date or a
  recorded exception.

### Rotation-cadence baseline (#1762, recorded 2026-11-01)

- **Baseline anchor:** this inventory came into force 2026-10-25. The
  90-day cadence (§3) for provider API keys and for signing / session /
  webhook secrets runs from that date.
- **First quarterly review — due 2027-01-23, owner: the human owner
  (Mubasher).** The CISO lane documents the review; it does not rotate
  provider keys on its own authority (§1). At that review every
  `Unknown` in §1–§2 becomes a rotation date or a recorded exception —
  an `Unknown` carried past 2027-01-23 without an exception is a review
  failure, not a baseline. The 180-day OAuth-client-secret and 12-month
  GitHub-App-key / Cloudflare-token cadences are checked at the same
  review and come due on their own clocks (2027-04-23 and 2026-10-25
  come due on their own clocks (2027-04-23 and 2027-10-25 respectively,
  counted from the baseline where no earlier date is recorded).
- **Baseline status at 2026-11-01:** exactly one row carries a date —
  the Alpaca pair, revoked and rotated by the human owner 2026-10-25
  (§4). Every other row is `Unknown`, which is the honest baseline:
  no lane has verified a live rotation date for any other row, and none
  is invented here.

### Owner-action record (#1762, status 2026-11-01 — honestly stated)

These two items are **owner actions, not code**, and this slice claims
neither of them done:

| Item | Owner action | Owner | Status |
|---|---|---|---|
| Slack `files:write` scope + app reinstall | Add the `files:write` scope to the Slack app and reinstall it, then verify a file post arrives (the bot token's current scope gap is the §2 `SLACK_BOT_TOKEN` row) | Human owner (Mubasher, Slack app owner) | **PENDING** — not done, not claimed; file posts cannot arrive until it is done |
| History purge for pre-#1486 Alpaca values | Decide whether to purge the pre-#1486 git history carrying the Alpaca-key-shaped values (§4). This is a **separate owner decision** from the rotation: the keys were revoked/rotated 2026-10-25 (owner-confirmed, §4), so purge is about history hygiene, not about killing a live credential. This lane performed no live-Alpaca verification and claims none. | Human owner (Mubasher) | **PENDING decision** — not done, not claimed; #768 stays closed and is NOT reopened by this slice |

When either item moves, its status row is updated in this document in the
same change that records the evidence — a status change without evidence
is not a status change.

## Appendix: referenced but not secrets

Names found by the sweep that are configuration, identifiers, or destinations
— recorded here so the cross-check is complete, and so nobody later mistakes
them for credentials (or mistakes a credential for one of them):

`APP_BASE_URL`, `ET_BASE_URL`, `ETRADE_BASE_URL`, `ETRADE_ENVIRONMENT`,
`PAYPAL_ENVIRONMENT`, `PAYPAL_WEBHOOK_ID`, `LEMONSQUEEZY_STORE_ID`,
`ALPACA_BASE_URL`, `CHANNEL_EMAIL_PRINCIPALS`, `SCREENER_EMAIL_TO`,
`SCREENER_SLACK_CHANNEL`, `MCP_JWT_SECRET` (referenced in a cfpay reference
document only; it is not a cfagent Worker secret on current main and is not in
the cfagent deploy sync — its owner action lives in its own lane, not here).
