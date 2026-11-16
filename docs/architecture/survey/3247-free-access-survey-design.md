# Free-for-lifetime / free-for-a-limited-time — design for #3247

## Revision log

- 2026-11-13: initial design. Verified against fresh `origin/main` = `d02e043a`
  (fetched this session; tip unchanged from the ~06:08 EST fetch). All file
  paths, line numbers, counts, and absences below were re-checked against
  that SHA, never asserted from memory.

## §0 — Inputs and decisions

### §0.1 Owner decisions (settled, not relitigated)

- **2026-11-05** (Mars, issue body): a free-for-lifetime option — access free
  forever, any activity requires payment. Distinct from #3245 (unlimited-free
  RUNS for approved accounts) and #3243 (time-boxed trial WITH included runs).
- **2026-11-11** (Mars, answering the pre-build questions): YES, build it. It
  must be **configurable**, meaning **it can be taken off** (revocable). PLUS
  **free-for-a-limited-time must be offered as part of it**.
- **2026-11-13 ~06:06 EST** (Mars): "get it done and open full prs (not
  draft)" — #3247 and #3307, PRs opened FULL (`draft:false`), not drafts.
- **Selective-admin decision** (2026-11-05): unlimited-free grants and
  per-run price approvals are selective, by platform admin and/or tenant
  admin. The #3247 grant follows the same selectivity in v1: operator
  grant/revoke, no self-service claim (R4).
- **Standing rules** (~/AGENTS.md, ~/MEMORY.md): one implementation of
  everything; every default externalized as operator data with a UI (no code
  constants); session-scoped identity always — no branch may use a
  client-supplied tenantId for scoping; queue-first always-merge; PR bodies
  need a repo-qualified Related (`OpenAIMP/cfagent#N`), the
  `## Agent #CBO-mlops` hashtag, a `Process documentation impact:` line, and
  an `Out of scope:` line (Policy Gate (k)); never write `#NNNN` in rendered
  JSX text under `src/client` (UX token ratchet).

### §0.2 Open questions — answered ON RECOMMENDATION

Per the 2026-11-13 directive, the issue's open owner decisions and the #3289
Q5 are answered here as explicit **decisions-on-recommendation** (R1–R14,
§1.3). Mars corrects any he disagrees with; nothing blocks on questions.
**Nothing genuinely needs Mars before build** — the recommendations cover
every open point. Each recommendation states its rationale and what would
change if Mars decides otherwise.

### §0.3 Design inputs (all read)

- #3289 design §3.6 (the `agent_free_access_grants` table shape), §6.2 (the
  three-mechanism distinction table, Accounts placement, Q5 statement), §8
  (two-slice pattern).
- #3246 design Rev 2 §3.8 (the READ CONTRACT this issue implements) and §6
  (mechanics belong to #3247).
- The decided entitlements-01.md 4-line freshness fix
  (`~/workspace/cbo-3246/entitlements-freshness-2026-11-12.md`), re-verified
  against current main — see §9.1.
- `docs/architecture/business/entitlements-01.md` on main (header, §4.1, §12,
  §13).
- Issue #3247's body (read back 2026-11-13; open, `lane:cbo-mlops`, no
  comments, untouched since filing 2026-11-05).

### §0.4 Verified current state (main `d02e043a`)

- **Nothing exists.** No `FreeAccessGrantPort`, no `agent_free_access_grants`
  table, no grant route, no grant UI anywhere on main (grep over `src/`,
  `tests/`, `docs/`). The only `freeAccess` traces are the #3246 mention
  plumbing: the `FreeAccessMention` type, the `mentionsEnabled.freeAccess`
  toggle (seeded true), the `PlanCompare` mention render, and the null pins
  in `tests/upgradeOffers.test.ts` (§4.3, §8).
- **The mention read site is built and waiting.** `src/services/upgradeOffers.ts`
  hardcodes `mentions: { referral: referralMention, freeAccess: null }`
  with the comment "Null until #3247 lands (no port exists) or no grant".
  The referral mention beside it is the exact pattern to mirror (§4.3).
- **The UI neighbor is built.** `src/client/UnlimitedFreeGrantSection.tsx`
  renders in `src/client/AccountAdminPanel.tsx` (Platform Admin → Accounts),
  beside `AccountVersionMoveSection`. The #3247 section goes directly after
  it (§4.1).
- **The latest migration is 0063** (`MIGRATION_0063_RUNS_PACKS`, last entry
  of `ALL_MIGRATIONS` in `src/data/migrationRunner.ts`). This design does NOT
  hardcode a migration number: the slice takes the **next free migration at
  build time** and re-checks before writing.
- **Pins at design time:** outcome catalog **141** in both pin files
  (`tests/outcome_catalog_2381.test.ts:246`,
  `tests/public_broker_3990.test.ts:515`); thin-router inventory **458**
  entries (`tests/thin_router_inventory.test.ts`, `EXPECTED_INVENTORY`).
  Both are re-measured at build time, never assumed (§8).

## §1 — The model

### §1.1 What the grant is

A **durable, auditable, revocable record of free access** for one login,
plus **exemption from any access/subscription fee**. That is all it is:

- It pins **NO allowance** (the Free allowance stays operator data, owned by
  the #3305/#3315 counter and allowance rows).
- It confers **NO tier** and **NO included runs** (unlike a #3243 trial).
- It makes **NO run free** (unlike a #3245 grant). The gate treats it as
  nothing — zero gate change, pinned by test (§5).
- It is **not a plan**: no price, no runs, no period, no Stripe object. It
  never appears in `GET /plans` (the buyable-versions surface) and never
  creates a subscription row.

**Honesty note (state it, don't hide it):** sign-in, browse, and view are
already free today — there is no access gate to open. What #3247 adds is the
explicit, durable, revocable **record** of the promise ("access free
forever"), the user-visible statement of it, and the exemption from any
**future** access fee. If no access fee ever exists, the grant's observable
effect is the record and the mention — that is the design, not a gap.

### §1.2 The three free-access mechanisms — distinct, do not merge

(From #3289 §6.2, unchanged; the third row is what this issue builds.)

| Mechanism | What it confers | Time-box | Revocable | Home |
|---|---|---|---|---|
| #3245 unlimited-free grant (shipped) | Runs free at price 0, bounded by the approved-free per-service quota (#3263) | Optional `expiresAtMs` | Yes (set grant to null) | Account row (`unlimitedFreeGrant`) |
| #3243 trial (shipped) | Subscribed tier + the version's included runs | `trialDays`, then period end | Lapses automatically; not a grant | Subscription row (`planId` = trial version) |
| #3247 free-for-lifetime / free-for-a-limited-time (this issue) | **Access free** — no subscription fee ever due for access; **any activity (runs) still requires payment/coverage** through the normal gate | Lifetime, or a limited window (`expiresAtMs`) | **Yes — "it can be taken off" (Mars 2026-11-11)** | `agent_free_access_grants` (new table, auditable grant/revoke history) |

**Limited-time differs from a trial in exactly:** no tier, no included runs
— only the access record for the window. A limited grant expiring changes
nothing about runs (they were never free); a trial expiring ends Subscribed
coverage. The two must never be confused in UI copy: the grant section says
"access", never "trial", never "runs".

### §1.3 Decisions-on-recommendation (R1–R14)

**R1 — Q5 semantics (the #3289 Q5, answered).** The grant confers the
durable record + the access-fee exemption (§1.1). It pins no allowance
beyond the implicit Free tier's operator-managed allowance, and it is not
an exemption from any *run* price. If Mars later wants the grant to pin an
allowance, that is a separate slice touching the counter — not a reinterpretation
of this one.

**R2 — Representation.** The §3.6 table (§2.1): an account-level record
keyed by login, in its own history table. NOT a tier value (tiers are
`Free | PayPerUse | Subscribed` and drive the gate), NOT a $0 plan row (a
plan row implies purchasable terms and a subscription row), NOT a flag on
the account row (a field carries no history; #3247 needs grant/revoke
history), NOT a second pricing source (the grant carries no price).

**R3 — Access vs activity.** Access = sign in, browse, view — everything
that does not start a run. Activity = any screen run, which goes through
the existing gate unchanged (free allowance → included runs → pack balance
→ credits → 402/skip). No new access enforcement is built: there is no
access gate today, and inventing one would be a new restriction, not a
free-access feature.

**R4 — Plan-list visibility: operator grant/revoke in v1; self-service
"choose" DEFERRED.** The issue body says a user can "see and choose" the
option in the pricing/checkout UX. The "see" half is built: the offer
mention (§4.3) and the billing-tab line (§4.2). The "choose" half — a
self-service claim in the plan list — is deferred as a
decision-on-recommendation: the grant is not a plan (R2), the plan list is
the buyable-versions surface, a choosable row would imply a purchase flow
that does not exist, and the selective-admin decision makes grants
selective. A self-service claim would need eligibility/abuse rules Mars has
not set; it is a follow-up decision, not silent scope.

**R5 — Lifetime end.** Revocation by an operator, or account deletion.
Never auto-converted to paid — no code path converts a grant into a
purchase, a trial, or a tier. No deletion cascade is built (no account-deletion
flow exists to hook); a grant whose login has no account is inert history.

**R6 — Grant target.** The target login must have an account row; otherwise
the grant route fails closed with 400, mirroring the #3244 subscription-grant
route's documented behavior ("a target with no account row fails closed
(400) — the operator creates the account first"). No auto-create on the
grant path (contrast: first subscription purchase auto-creates; the grant
path does not). The tenant for the audit comes from the target's account
row, never from a client-supplied tenantId; `grantedBy` is the
session-verified operator login, never a client-supplied value — both
mirroring the #3245 upsert route.

**R7 — One active grant per login; replace semantics.** Granting while an
active grant exists revokes the old row (`revokedAtMs` set, `revoked` audit
emitted) and inserts the new row (`granted` audit emitted), in one route
call. Rationale: matches #3245's one-grant-slot shape; an operator
correcting kind/expiry needs one action, not two; history is preserved in
the revoked row. The port performs the sequence (§2.2); the route audits
both events.

**R8 — Limited expiry is explicit operator input.** A limited grant
REQUIRES `expiresAtMs` in the future; a lifetime grant FORBIDS it. The
kind/expiry coherence is enforced by the port assert (400 on violation).
There is NO default window constant anywhere — no seeded "30 days", no
policy default. The expiry is per-grant operator data entered in the grant
form, which is what the externalized-defaults rule requires (a default
would be a code constant; an explicit per-grant input is operator data).

**R9 — Expiry and revocation are filters, not deletions.** `getActiveGrant`
returns the newest unrevoked, unexpired row. Expired and revoked rows stay
in the table as history. No retention sweep in v1 (mirrors the #3246
suppression-retention deferral); expired rows are inert.

**R10 — Revocation attribution lives in the audit event.** The table keeps
the §3.6 shape plus `id` (§2.1) — no `revokedBy` column. The
`commercial.free_access.revoked` audit event carries the revoking operator's
login, following the #3245 pattern (revocation recorded in audit, not in a
field).

**R11 — No money artifacts.** No Stripe object, no checkout, no
journal/ledger/claim writes (a grant is not a money event — nothing is
charged, credited, or redeemed), no outcome-catalog codes (routes use the
plain-error style of the account-upsert and subscription-grant routes), no
billing-policy additions (no tunable defaults exist for this feature).

**R12 — The mention implements the #3246 §3.8 read contract exactly.**
`FreeAccessGrantPort.getActiveGrant(login)` projected to
`{ kind, expiresAtMs } | null`; absence-tolerant (unbound port → null,
store error → null, `mentionsEnabled.freeAccess` false → null); never
affects offer eligibility (§4.3).

**R13 — Tenant scoping.** The grant row carries NO `tenantId` column (the
§3.6 shape has none). It is keyed by login; one login has one account row
with one tenantId, so login-scoping coincides with account-scoping. The
audit event's tenantId comes from the target account row (R6).

**R14 — No neighboring-surface changes.** No first-run/onboarding change
(the grant is operator-assigned, not part of signup; the onboarding trial
offer is untouched). No `AccountView` change (the grant read is a dedicated
route, §3.3 — the account view feeds first-run identity and must not grow
a grant field). No new admin tab, nav item, or icon (the section lives
inside Accounts; the billing line lives inside the billing panel).

## §2 — Data model

### §2.1 New table: `agent_free_access_grants` (next free migration)

The #3289 §3.6 shape, plus a server-generated `id` (every table in the
registry has one; cf. `agent_version_moves.id`, #3289 §3.8):

| Column | Type | Notes |
|---|---|---|
| id | text PK | Server-generated. |
| login | text, not null | The granted login. Indexed (history reads are per-login). |
| kind | text, not null | `"lifetime"` \| `"limited"`. |
| grantedBy | text, not null | Session-verified operator login. Never client-supplied. |
| grantedAtMs | integer, not null | Server time at grant. |
| expiresAtMs | integer, nullable | Null for lifetime; required, future, for limited (R8). |
| revokedAtMs | integer, nullable | Null while active; set on revoke/replace (R7, R9). |
| reason | text, not null | Operator-entered reason, required (mirrors #3245). |

No seed rows. No tenant column (R13). No price, runs, or tier column (R2).
Drizzle table `agentFreeAccessGrants` in `src/data/drizzleSchema.ts`,
following the `agentRunsPackVersions` declaration shape. The migration
takes the **next free number at build time** (0063 was latest at design
time); the registry test stays canonical — a well-formed migration passes
as-is, expect zero changes to `tests/migration_registry.test.ts` (builder
verifies).

### §2.2 Ports (ADR 0002, port-first)

**New** `src/data/freeAccessGrantPorts.ts` — imports no store client,
references no env binding, writes no SQL (the `runsPackPorts.ts` header
pattern):

```ts
export type FreeAccessGrantKind = "lifetime" | "limited";

export interface FreeAccessGrantRecord {
  id: string;
  login: string;
  kind: FreeAccessGrantKind;
  grantedBy: string;
  grantedAtMs: number;
  expiresAtMs: number | null;
  revokedAtMs: number | null;
  reason: string;
}

export interface FreeAccessGrantPort {
  /** The active grant for the login, or null. Newest unrevoked, unexpired row. */
  getActiveGrant(login: string, nowMs: number): Promise<FreeAccessGrantRecord | null>;
  /** Full history for the login, newest first (active + revoked + expired). */
  listGrants(login: string): Promise<FreeAccessGrantRecord[]>;
  /**
   * Grant (replacing any active grant, R7). Returns the new row and the
   * replaced row, if any, so the route can audit both events.
   */
  grant(input: {
    login: string; kind: FreeAccessGrantKind;
    expiresAtMs: number | null; reason: string;
    grantedBy: string; nowMs: number;
  }): Promise<{ granted: FreeAccessGrantRecord; replaced: FreeAccessGrantRecord | null }>;
  /** Revoke the active grant, if any. Returns the revoked row, or null. */
  revokeActive(login: string, nowMs: number): Promise<FreeAccessGrantRecord | null>;
}
```

- `assertFreeAccessGrantKind`, `assertFreeAccessGrantInput` validators:
  kind must be `"lifetime" | "limited"`; reason a non-empty string;
  kind/expiry coherence (R8: lifetime ⇒ `expiresAtMs` null; limited ⇒
  integer `> nowMs`). The assert refuses before any write, so a bad grant
  is 400 and grants nothing (the #3245 `assertUnlimitedFreeGrant` pattern —
  builder verifies whether that assert caps reason length and mirrors it).
- Pure predicate `isFreeAccessGrantActive(grant, nowMs)` in the ports
  module (mirrors `isUnlimitedFreeGrantActive` in `commercialPorts.ts`):
  `revokedAtMs === null && (expiresAtMs === null || expiresAtMs > nowMs)`.
  Unit-testable without D1. `getActiveGrant` applies it; the adapters apply
  the same filter in SQL / in-memory scan.
- The #3246 §3.8 read contract is satisfied by projection: the mention
  reader in `upgradeOffers.ts` maps the record to
  `{ kind, expiresAtMs }` (§4.3). The port returns the full record because
  the operator routes need `grantedBy`/`reason`/history; the mention type
  (`FreeAccessMention`, already on main) is unchanged.

**Adapters** (the runs-pack / free-run-counter precedent — verify exact
filenames at build, they follow the established naming):

- `src/data/d1FreeAccessGrantAdapter.ts` — Drizzle D1 adapter;
  `ensureFreeAccessGrantSchema(db)` via `applyMigrations` with the
  prerequisite list (the #3246 slice-3 lesson: the ensure list must include
  the new migration AND its prerequisites — the builder copies the
  `ensureRunsPackSchema` shape in `d1RunsPackAdapter.ts` and verifies the
  list, because a missing prerequisite fails only on a fresh DB).
- `src/data/inMemoryFreeAccessGrantAdapter.ts` — in-memory mirror, same
  semantics (replace, filters, ordering).
- `src/data/createFreeAccessGrantPorts.ts` — composition root:
  `createFreeAccessGrantAdapter(env)` returns the D1 adapter or **null when
  `AGENT_DB` is unbound** (absence is a normal, non-error state; callers
  keep their fail direction — fail-closed on the operator routes, null
  mention on the offer surface). Re-exports the ensure function.
- **Single-statement D1 ops** (ADR 0002): grant = one INSERT (after the
  revoke-old UPDATE, a separate single statement — the port sequences two
  single statements, it does not build a multi-statement transaction);
  revoke = one conditional UPDATE (`revokedAtMs IS NULL AND (expiresAtMs IS
  NULL OR expiresAtMs > ?)`) with an applied-check; reads are single
  SELECTs. No `mas_*` tables, no journal writes (R11).

### §2.3 What is NOT added

No account-row field (R2). No billing-policy block (R11 — no tunable
defaults). No catalogue/plan rows. No subscription-row change. No
`FreeAccessGrantPort` read in the gate, the seam, or any purchase route
(§5).

## §3 — Routes

All three routes live in `handleAgenticPaymentsRoutes`
(`src/agents/routes/agenticPayments.ts`), beside the other commercial
routes — the one route file, no new handler. Route conditions use the
existing `path.endsWith(...)` + method pattern, so the thin-router
inventory gains exactly three entries in registration order (§8).

### §3.1 POST `/payments/agentic/commercial/free-access/grant` (operator only)

Body: `{ userId, kind, expiresAtMs?, reason }`.

- Auth: verified login required (401); `isStoreOperator(login)` required
  (403 `"Forbidden: store operator required."`) — the #3245/#3244 pattern.
  A tenant admin who is not a store operator cannot grant in v1 (R14 note:
  the tenant-admin grant path is undecided; this route does not invent it).
- Validation (400, plain `{ error }`, before any write): `userId`
  non-empty string; `kind` asserted; kind/expiry coherence (R8); `reason`
  non-empty string. `grantedBy` is the session login, never read from the
  body. A client-supplied `tenantId` is ignored (never read).
- Store: unbound store → 503 (the `requireStore`-style pattern). Target
  with no account row → 400 (R6). The account row is read for the audit's
  tenantId.
- Effect: `port.grant(...)` — replace semantics (R7). Audits, in order:
  `commercial.free_access.revoked` for the replaced row (if any), then
  `commercial.free_access.granted` for the new row. Payloads mirror the
  #3245 events (`userId`, `tenantId`, `grantedBy`, plus `kind`, `reason`,
  `expiresAtMs` on granted; `revokedBy: login` on revoked — R10).
  Audit failure handling follows the route file's convention for grant
  writes (builder verifies: the #3245 upsert audits synchronously; the
  offer routes treat audit failure as 503 — the grant route follows the
  #3245 upsert, the closer precedent, and the builder states the choice in
  the PR body if it differs).
- Response: `200 { granted, replaced }` (full records, §2.2 shape).
- NOT gated on the monetization flag (mirrors #3244: a grant is operator
  data, like an operator tier grant, not a purchase).

### §3.2 POST `/payments/agentic/commercial/free-access/revoke` (operator only)

Body: `{ userId, reason? }`.

- Auth: same as §3.1 (401/403).
- Validation: `userId` non-empty (400). `reason` optional; when present it
  rides the audit event only (the row carries no revoke reason — R10).
- Effect: `port.revokeActive(...)`. No active grant → **404** with a plain
  error (the operator UI only offers revoke when a grant is shown, so a
  revoke with no grant is a stale UI — 404 is honest, not idempotent
  silence). Active grant → row revoked, audit
  `commercial.free_access.revoked` (`userId`, `tenantId` from the account
  row, `revokedBy: login`, `kind`, optional `reason`).
- Response: `200 { revoked }` (the revoked record).
- NOT gated on the monetization flag (same reason as §3.1).

### §3.3 GET `/payments/agentic/commercial/free-access?userId=` (own or operator)

The one read route, serving both the operator section (target lookup) and
the user's own billing-tab line. Mirrors
`GET /payments/agentic/commercial/referral/balance` exactly:

- Auth: verified login required (401); `userId` query param required (400);
  `canAccessAccount(login, userId)` — own login or store operator —
  otherwise 403. Unbound store → 503.
- Response: `200 { userId, active, history }` where `active` is the
  `getActiveGrant` record or null, and `history` is `listGrants` (newest
  first). Same shape for self and operator reads (it is the subject's own
  record; the referral-balance route likewise returns one shape).
- No audit event on read (reads are not audited anywhere in this file;
  grant/revoke writes are).
- The view shape returned (`FreeAccessGrantView`) is the record shape
  (§2.2) — the client validates it with an `isGrantView`-style guard,
  mirroring `UnlimitedFreeGrantSection.tsx`.

### §3.4 Route inventory delta

Three new route conditions (§3.1–§3.3). Thin-router count moves 458 → 461
**only if no other lane lands routes first — MEASURE at build, never
assume** (§8). No new outcome-catalog codes (R11) — the 141 count is
unmoved.

## §4 — UI

### §4.1 Operator grant/revoke section (slice 2)

**New** `src/client/FreeAccessGrantSection.tsx`, rendered in
`src/client/AccountAdminPanel.tsx` **directly after**
`<UnlimitedFreeGrantSection>` (beside the unlimited-free grant section, per
#3289 §6.2 — the section reads the looked-up account's login from
`lookup.identity.userLogin`, the same prop the grant section takes).

- Reads `GET /free-access?userId=<lookup login>`; shows the active grant
  (kind, expiry or "No expiry", granted by, granted date, reason) or "No
  free-access grant on this account."; shows history (revoked/expired rows,
  compact: kind, window, revoked state) below.
- Grant form: kind radio (lifetime / limited); expiry date input shown only
  for limited (required; must be in the future — client-side check mirrors
  the server assert, the server remains authoritative); reason input
  (required); Grant button → §3.1. When an active grant exists, the form
  states plainly that granting replaces it (R7).
- Revoke button (shown only when an active grant exists) → §3.2, with the
  stale-UI 404 surfaced as "The grant is already gone — reloaded." (the
  section re-reads after any write).
- Copy rules: says "access", never "trial", never "runs"; never promises
  free runs; never uses the word "unlimited" (that is the #3245 grant's
  word). **No `#NNNN` issue reference in any rendered text** (UX token
  ratchet — write "issue 3247" without the hash if a reference is needed at
  all; prefer no reference in UI copy).
- Built strictly with `src/client/components/ui/` primitives and token-only
  styling; all calls through `src/client/apiFetch.ts` (the #71 rule); the
  `UnlimitedFreeGrantSection.tsx` file header is the pattern to copy
  (operator-only note, route contract, 403 meaning).

### §4.2 User-visible grant line (slice 2)

The billing tab (`?tab=billing`, `BillingServicingPanel.tsx`) is the
user-facing servicing surface and is NOT admin-gated. `UsageBillingSection`
— the section that already renders the user's own referral state — gains a
free-access line:

- Reads `GET /free-access?userId=<own login>` (self read, §3.3) via
  `apiFetch`.
- Renders "Free access: lifetime." / "Free access until {date}." when an
  active grant exists; renders **nothing** when null (no noise for
  ungranted users — the referral mention's "renders only when state
  exists" rule, #3246 §3.8).
- The line states access only; it links nowhere and offers no action (the
  grant is operator-managed; R4). Builder verifies the exact insertion
  point inside `UsageBillingSection` (beside the referral block is the
  expected spot; if the section's shape resists it, a sibling section in
  the same panel is acceptable — record the choice in the PR body, do not
  invent a third surface).

### §4.3 Offer mention light-up (slice 2, server-side)

No client change: `PlanCompare.tsx` already renders the mention
(`freeAccess.kind === "lifetime"` → lifetime copy, else "until {date}"),
`FreeAccessMentionView` already exists in `commercialApi.ts`, and the
`mentionsEnabled.freeAccess` toggle already exists in `OfferRulesSection`
(seeded true). Slice 2 lights it up server-side:

1. `ResolveOfferPorts` (`src/services/upgradeOffers.ts`) gains an optional
   `freeAccess: FreeAccessGrantPort | null` field, beside `referral`.
2. `bindOfferPorts` (`src/agents/routes/agenticPayments.ts`) binds
   `createFreeAccessGrantAdapter(env)` + `ensureFreeAccessGrantSchema`,
   beside the `referral` binding.
3. The mention computation mirrors the referral block exactly: only on
   eligible payloads, only when `rules.mentionsEnabled.freeAccess` is true
   and the port is bound, inside try/catch degrading to null on store
   failure (a mention-store outage must never hide the at-limit offer).
   The mention projects the record to `{ kind, expiresAtMs }` (R12).
   The hardcoded `freeAccess: null` at the eligible return becomes the
   computed mention; the ineligible return keeps `freeAccess: null`
   (ineligible payloads carry no mentions — pin stays, §8).
4. Eligibility is untouched: the grant never enters the coverage mirror,
   the ladder, or any rule (§5). The mention is pure information.

## §5 — Gate interaction: NONE (hard boundary)

**Zero gate change.** `src/services/nativeMonetization.ts` `check()` reads
only the account row (`account.unlimitedFreeGrant`, the #3245 grant) —
verified on main `d02e043a`, the only grant reads in the file. No
`FreeAccessGrantPort` import, no read, no step, no `paidVia` value is added
to the gate, the seam (`paidScreenSubmission.ts`), the payment workflow, or
any purchase/confirm route. A granted login hits the gate exactly as an
ungranted login with the same account/tier/credits/runs: free allowance,
then included runs, then pack balance, then credits, then 402/skip.

**Pinned by test** (slice 1, §8): a dedicated gate-behavior test file
mirroring `tests/approved_free_quota_gate_3263.test.ts` drives `check()`
through the standard in-memory harness with a grant row present in the
store and asserts the outcome is identical with and without the grant —
payment still required (402 `payment_required` on manual, skip on
recurring) and `paidVia` never grant-related. The test fails if any future
change lets a grant make a run free; that is the point.

## §6 — Boundaries: explicitly NOT in #3247

- **Self-service "choose" in the plan list** (R4 — deferred, needs
  eligibility/abuse rules + an owner decision; the issue's "choose" half).
- **Tenant-admin granting.** The routes are store-operator-only, like #3245.
  The tenant-admin grant/approval path is undecided (draft pending Mars);
  this issue does not invent it.
- **Any gate, seam, or purchase-route behavior change** (§5 — hard
  boundary).
- **Any access enforcement.** No sign-in/browse/view gate is built (R3).
- **Any allowance, tier, or runs conferral** (R1 — the grant is
  access-only).
- **Any price, plan, catalogue, or Stripe change** (R2, R11). No version,
  no approval, no checkout.
- **#3307 referral mechanics.** The offer mention's referral half is
  untouched; no code, rule, or attribution work rides here.
- **Retention sweep** for expired/revoked rows (R9 — follow-up slice, if
  ever; rows are inert history).
- **Per-tenant grants / tenant-scoped grant reads** (R13 — login-keyed by
  design; multi-tenant grant scoping is the #2856 track's territory, not
  started until Mars orders it).
- **Email/notification on grant/revoke/expiry.** No new channel; the audit
  events are the record.
- **Backfill.** No existing login is granted anything by the migration or
  by either slice. The first grant is an explicit operator action after
  landing (consistent with "none granted yet" for #3245 and the
  selective-admin decision).

## §7 — Slice split

**Two sequential PRs, both opened FULL (`draft:false`)** per the 2026-11-13
directive. Do NOT file sub-issues — the split is recorded here and in the
PR bodies. Slice 1 lands the mechanics with no user-visible behavior change
(the mention stays null, no UI calls the routes); slice 2 lights up the
mention and ships the UI. Each slice: claim comment first (naming slice +
branch), full PR, green CI on its head → ready + auto-merge via the queue
per the standing always-merge directive, never over red/conflict.

### Slice 1 — Server: migration + port + routes + gate pin + doc fold

- Migration (next free number): `agent_free_access_grants` table + login
  index; registry entry in `ALL_MIGRATIONS`.
- `src/data/freeAccessGrantPorts.ts` (port, record, validators, pure
  `isFreeAccessGrantActive`); `src/data/d1FreeAccessGrantAdapter.ts`;
  `src/data/inMemoryFreeAccessGrantAdapter.ts`;
  `src/data/createFreeAccessGrantPorts.ts` (composition root, null when
  unbound); `src/data/drizzleSchema.ts` (`agentFreeAccessGrants`).
- `src/agents/routes/agenticPayments.ts`: the three §3 routes, in the
  route file's existing commercial section, in registration order.
- **Deliberately NOT in slice 1:** any touch to `upgradeOffers.ts`,
  `bindOfferPorts`, or any client file. The mention stays null through
  slice 1 (the §3.8 contract tolerates the unbound port), so the
  `tests/upgradeOffers.test.ts` pins stay green unmodified.
- Tests: `tests/freeAccessGrants.test.ts` (port/adapter parity, validators,
  replace semantics, expiry/revocation filters, history ordering);
  `tests/freeAccessGrantRoutes.test.ts` (401/403/400/404/503, audit
  emission for grant/revoke/replace, no client-trusted tenantId/grantedBy,
  no-account-row 400, unbound-store 503);
  `tests/free_access_gate_3247.test.ts` (the §5 pin — grant never makes a
  run free, mirroring `tests/approved_free_quota_gate_3263.test.ts`);
  thin-router inventory update (3 entries, registration order, measured).
- Docs: the entitlements-01.md freshness fold (§9.1) — this is the first
  #3247 slice touching the doc, so it carries the decided fold.
- `changelog.d/<slug>.md` fragment (Policy Gate (d): first non-empty line
  `### ` + a bullet; never edit CHANGELOG.md). Each slice carries its own
  fragment — the gate is per-PR. Slug convention verified at build.

### Slice 2 — Client + mention light-up + pin updates

- `src/services/upgradeOffers.ts`: `freeAccess` port field + mention
  computation (§4.3). `src/agents/routes/agenticPayments.ts`:
  `bindOfferPorts` binds the adapter + ensure (§4.3). No other server
  behavior change.
- `src/client/FreeAccessGrantSection.tsx` (new) + its render in
  `src/client/AccountAdminPanel.tsx` directly after
  `UnlimitedFreeGrantSection` (§4.1).
- `src/client/UsageBillingSection.tsx`: the free-access line (§4.2).
- Tests: `tests/free_access_grant_3247_ui.test.tsx` (section render, grant
  form kinds/expiry/reason, replace disclosure, revoke, stale-404 reload —
  mirroring `tests/unlimited_free_grant_3245_ui.test.tsx`); billing-line
  test (renders for lifetime/limited, renders nothing when null);
  `tests/upgradeOffers.test.ts` pin update (§8: the `:635` null assertion
  becomes the mention matrix; the `:664` ineligible pin stays).
- Docs: the shipped record in entitlements-01.md (§9.2).
- `changelog.d/<slug>.md` fragment (own fragment, per-PR gate).

### Explicitly NOT a third slice

Two slices suffice: the server surface is one table + one port + three
routes, and the client surface is one section + one line + a
server-computed mention whose render already exists. A third slice would
be ceremony, not risk reduction. If slice 2's pin updates grow (e.g. a
second pin file asserts the null mention — §8 names the grep), the slice
absorbs them; it does not split.

## §8 — Tests and pins (builder must re-measure, never assume)

**Pre-push checklist additions** (on top of the standing Tier 1 + ratchet
sweeps in ~/AGENTS.md):

1. **Outcome catalog — UNMOVED.** No new codes (R11). Both pins stay 141:
   `tests/outcome_catalog_2381.test.ts:246` and
   `tests/public_broker_3990.test.ts:515` (the #3246 lesson: grep the whole
   `tests/` tree for the old literal AND the assertion shape —
   `grep -rn "toHaveLength(141)" tests/` — before pushing; a second pin in
   another file is the failure mode).
2. **Thin-router inventory — MOVES by the new route conditions.** 458 at
   design time; slice 1 inserts the three §3 route entries in registration
   order and measures the new count. `grep` for any second inventory/count
   assertion before pushing.
3. **Migration registry — next free number, canonical test.** Expect zero
   changes to `tests/migration_registry.test.ts`. The D1 adapter's ensure
   list must include the new migration + prerequisites (the #3246 slice-3
   ensure-list lesson — verify on a fresh DB, not just the migrated one).
   Grep `tests/` for the old latest number (`0063`) in any pin before
   pushing.
4. **Admin/nav pins — UNMOVED.** No new tab, item, or icon (R14): the
   left-nav, admin-panel, admin-page, and nav-config-data pins must not
   move. Grep `tests/` for `PLATFORM_ADMIN_TABS` / `free-runs` /
   `UnlimitedFreeGrantSection` counts and confirm zero movement; a moved
   pin means the slice accidentally touched a pin file.
5. **Offer pins — slice 2 only.** `tests/upgradeOffers.test.ts:635`
   (`expect(payload.mentions.freeAccess).toBeNull()` in the referral-mention
   test) becomes the mention matrix: lifetime renders `{ kind: "lifetime",
   expiresAtMs: null }`; limited renders kind + expiry; toggle off hides;
   unbound port → null; store failure → null (offer still eligible);
   referral + freeAccess coexist. `:664` (ineligible payloads carry no
   mentions) STAYS. Fixtures carrying `mentions: { referral: null,
   freeAccess: null }` (`tests/commercial_offer_api_3246.test.ts`,
   `tests/planCompare.test.tsx`, `tests/checkout_offer_preselect_3246.test.tsx`,
   `tests/upgradeOffer.test.tsx`) are fixtures, not assertions — the
   builder verifies none of them asserts the null, and updates any that
   does. `tests/planCompare.test.tsx` already covers the mention render —
   no change expected.
6. **Gate pin — slice 1** (§5): `tests/free_access_gate_3247.test.ts`.
   The gate's own suites (`tests/native_monetization_gate.test.ts`,
   `tests/approved_free_quota_gate_3263.test.ts`) must pass unmodified —
   the slice touches no gate file.
7. **Whole-tree scan/ratchet tests pre-push** (the #4126/#4217 lesson): run
   the UX token-coverage ratchet, the console-migration ratchet, and the
   migration-pin checks locally even though the full shards run in CI. New
   JSX must contain no `#NNNN` text and no raw color literals; new files
   must contain no `console.*` and no dead `eslint-disable` directives
   (lint-changed only checks touched files — a dead directive in a touched
   file fails Fast gates).
8. **Never touched:** `tests/actor-ports-conformance.test.ts` (if the
   additive port breaks it, escalate to the parent — do not edit it); no
   other lane's in-flight work; no flag, price, grant, or secret changes.

**Verification plan (what the tests prove):**

- Port/adapter parity: D1 and in-memory agree on grant/revoke/replace/
  active-filter/history-ordering, including the conditional-update
  applied-check on revoke.
- Validators: kind/expiry coherence both directions; empty reason refused;
  future-expiry required for limited.
- Routes: the full status matrix (§3), both audit events with the right
  payloads (including the replace pair), client-supplied tenantId/grantedBy
  ignored, no-account-row 400, unbound 503.
- Gate pin (§5): identical gate outcomes with and without a grant row.
- Mention matrix (slice 2, §8.5): the contract + the degradation rules.
- UI: section render/states, form validation, replace disclosure, revoke +
  stale reload, billing line render/nothing, no `#NNNN` in rendered copy
  (covered by the token ratchet, asserted in the UI test too if cheap).

## §9 — Doc updates

### §9.1 Slice 1 carries the decided freshness fold (exact edits)

Re-verified verbatim against main `d02e043a` at design time. The #3246
clause reads **shipped/closed** (all three slices merged, issue closed
2026-11-13). Do NOT bump the "Verified against" line (line 5). Line 84
(triggered trigger, unbuilt) STAYS. Lines 174/208/238 ("slices 1–2") are
historical shipment records of what those slices delivered — they stay;
slice 3's addition is already recorded in the §2.1 gate-order clause
(line 42).

File: `docs/architecture/business/entitlements-01.md`.

**Edit 1 — line 6 (header Related line).**
OLD:
`#3246 (upgrade offers, unbuilt), #3247 (free-for-lifetime, undecided).`
NEW:
`#3246 (upgrade offers; shipped, slices 1–3, issue closed 2026-11-13), #3247 (free-for-lifetime; decided 2026-11-11 — build it, configurable/revocable, plus free-for-a-limited-time).`

**Edit 2 — line 96 (§4.1 Free-for-lifetime bullet).**
OLD:
`- **Free-for-lifetime** (#3247: access free forever, any activity requires payment) is a separate filed option. It is not decided by this definition and grants no runs.`
NEW:
`- **Free-for-lifetime** (#3247: access free forever, any activity requires payment) is a separate filed option. Decided 2026-11-11 (owner): build it, configurable/revocable, plus a free-for-a-limited-time variant. It grants no runs by itself.`

**Edit 3 — line 231 (§12 still-to-verify bullet).**
OLD:
`- The first account(s) for the unlimited-free grant (decision 1, open) and the product configuration UI build (decided, unbuilt).`
NEW:
`- The first account(s) for the unlimited-free grant (decision 1, open).`
(The product configuration UI clause is deleted, not moved: it shipped in
#3289 slices 1–2 and is already recorded in §8 and §12.)

**Edit 4 — line 236 (§13 quotas clause).**
OLD:
`It does not set per-run prices, trial lengths, or per-service quotas — those are operator data (or, for quotas, #3263, unbuilt) and are decided separately.`
NEW:
`It does not set per-run prices, trial lengths, or per-service quotas — those are operator data (or, for quotas, #3263, shipped — see §5.3) and are decided separately.`

At build time the builder re-reads the four lines against current main
(main moves fast; another lane may touch the doc first) and applies the
same four edits to whatever the lines then say. If a line has already been
fixed by another lane, the builder takes only the remaining ones and says
so in the PR body.

### §9.2 Slice 2 adds the shipped record

One sentence in §4.1 (after the folded Edit 2 line) recording the build:
grant/revoke UI in Platform Admin → Accounts, the offer mention, and the
billing-tab line — with the two slice PR numbers. Plus one line in §12's
shipped record (line 238's list) naming #3247 as shipped. No other doc
edits. (Builder verifies the §12 list's shape at build time; if the list
has moved, the record goes in the same list, not a new section.)

### §9.3 Changelog fragments

One fragment per slice PR (Policy Gate (d) is per-PR): slice 1 describes
the server delivery (table, port, routes, gate pin); slice 2 describes the
UI + mention light-up. First non-empty line `### `, plus a bullet. Never
edit CHANGELOG.md.

### §9.4 No other doc updates required

The platform-entity-capability-map: builder checks whether it names
free-access grants; if it has a grants section, one row is added in slice
1 — verify at build, do not assert here. The lifecycle doc, gitops.md, and
templates are untouched. No process or template change in either slice
(the PR bodies carry the standard `Process documentation impact:` line
stating that).

## §10 — Build-time verifications (the builder must re-check, not assume)

1. Migration number: re-check `ALL_MIGRATIONS` tail before writing; take
   the next free number.
2. Adapter filenames: verify the `d1*` / `inMemory*` / `create*Ports`
   naming against the runs-pack and free-run-counter files at build time.
3. `assertUnlimitedFreeGrant`'s reason validation: mirror its shape
   (including any length cap) in `assertFreeAccessGrantInput`.
4. Audit-failure direction on the grant route: verify the #3245 upsert
   convention (§3.1) and state the choice in the PR body if it differs.
5. Thin-router count + outcome-catalog count: measure, grep for second
   pins (§8.1–§8.2).
6. `UsageBillingSection` insertion point for the billing line (§4.2).
7. The four fold lines: re-read against current main (§9.1).
8. The `mentionsEnabled.freeAccess` seed is still true (it was true at
   design time; if an operator flipped it, the mention stays hidden until
   flipped back — that is correct behavior, not a bug).
9. Confirm no other lane landed a `free_access` route, table, or port
   first (grep before writing; on collision, escalate — one implementation
   of everything, no duplicates).
10. Full PRs (`draft:false`), claim comment first, Policy Gate local repro
    against the single-parent head, Tier 1 + ratchet sweeps pre-push,
    queue-first merge. PR bodies: repo-qualified Related, hashtag,
    process line, `Out of scope:` line.
