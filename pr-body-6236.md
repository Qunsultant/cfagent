# PR body — fix(6236): remove stranded/stale ids and accounts

## Summary
Implements cfagent #6236 (owner directive 2026-11-23, highest priority) and subsumes #6240 — no separate PR for #6240. A new application-level cleanup pass removes every stranded / stale identity, alias row, and reverse-index entry in the production IAAA store, through the store interfaces only (no SQL, no hand-editing). It also fixes the root cause of the bootstrap panel reporting both owner identities as "Unresolved (match nobody)".

## Linked issue
- #6236 — Remove all stranded / stale ids and accounts
- #6240 — [RCA] Login still resolves to the revoked stranded Oct 22 identity (subsumed; no separate PR)

## Specification
Per #6236 (spec: `~/workspace/tmp-issues/remove-stranded-stale-ids-body.md`):
- Inventory ALL stranded/stale ids/accounts in the production IAAA store and remove them THROUGH THE APPLICATION ONLY.
- Known items: (1) stranded Oct 22 identity `00fbb0ba-9e4b-43ec-a7d6-df2a1dfc5d6c` — stale alias row + reverse-index entry still point at it while the session carries derived id `v1:289a63…`; (2) revoked original membership `4542cd6a-be4a-4380-a65b-a989b3e3ee72` (revoked 2026-10-23); (3) stale alias rows + stale reverse-index entries for any binding already migrated to a derived id.
- Scope also: minted pre-#1182 ids superseded by derived `v1:` ids; memberships whose only reference is a stale per-user index entry or a revoked record; `iaaa-alias:` rows whose old id is fully migrated; reverse-index entries pointing at retired ids; bootstrap-list entries that no longer match a live identity.
- Do NOT destroy audit evidence: for EACH item, name whether it is deleted or archived and where the audit trail lives.
- Do NOT touch the two live owner identities (GitHub `https://github.com:82253453`, Google `https://accounts.google.com:116080816274398642624`) or their derived ids and active platform-admin + tenant-admin grants.
- Live verification after merge/deploy (login path + Users view resolve to derived ids; bootstrap proposals no longer list "Unresolved" for the owner identities) is done by the parent via the browser.

## Implementation
- **New module `src/security/iaaaStaleCleanup.ts`** — `runStaleIdentityCleanup` inventories alias rows, reverse-index entries, and memberships through the caller's application-level list functions, and deletes a row only when the id it names is provably retired (the known stranded id, or an `iaaa-alias:migrated:` forward pointer exists) AND no live binding still carries it (the by-provider record is authoritative; a reverse entry that still resolves to the id blocks deletion of that id's rows). Deletion paths: KvLike deletes for alias rows, `IdentityBindingStore.removeByUserAndIssuer` for reverse entries. The pass never throws; store failures are named in `errors` and it continues.
  - Per-item dispositions, named in the report: `migrated:` forward pointer NEVER deleted (`retained-forward-pointer`); revoked membership under a retired id RETAINED as audit history, never deleted (`retained-audit-history` — including the revoked 2026-10-23 membership `4542cd6a-…`; its audit trail is the membership record itself plus the `iaaa.stale_identity_cleanup` audit event naming it); active grant under a retired id reported only (`reported-only` — a live grant with a stale key; the #1210 repair moves it, this pass never deletes a live grant); orphan row (no migration record, no live binding) or corrupt row reported only, never deleted without proof.
  - Every deletion in execute mode writes one `iaaa.stale_identity_cleanup` audit event through the caller's audit callback; an audit failure is named in `auditFailures` and never stops the pass.
  - `cleanupStrandedIdReferences` — targeted pass for `STRANDED_PLATFORM_ADMIN_ID` only (one alias get + one reverse-index listing filtered to the stranded id, no full scan). The shared `login:` row is deleted only when it still points at the stranded id; a login row re-recorded onto the derived id survives.
- **Surfaces:** targeted stranded-id pass on platform-listed logins in execute mode, after the #1210 repair in `completeWiredLogin` (best-effort, never changes the login outcome); admin endpoints `GET /api/iaaa/stale-identities` (dry-run inventory — the #6240 alias-row surface, so a stale alias is visible instead of inferred) and `POST /api/iaaa/stale-identities/cleanup` (runs the pass in the configured mode), both platform-admin only (same gate as the bootstrap routes), answering 500 with no partial data on a listing failure. The response names what was deleted, what was retained, bootstrap forward-resolutions, and the verified-live grants (`verifiedLive`) for every resolved bootstrap id.
- **Bootstrap "Unresolved" root cause (fixed here):** `currentBootstrapEntries` split the env list per comma and dropped bare role segments, so `platform,tenant:<identity>` canonicalized to `tenant:<identity>` (the platform role silently lost) and the current-list resolver then misread the `tenant:` prefix as part of the issuer — both owner identities reported "Unresolved (match nobody)". Pending bare roles are now carried onto the next identity segment; the current-list resolver (and the propose handler, same bug) parse entries with `parseBootstrapListWithGenesis`; a bare id naming a retired id forward-resolves through its migration record (reported in `forwardResolved`); `isPlatformBootstrapListed` matches a retired bare id through its forward pointer when the alias kv is supplied.
- **Config:** `IAAA_STALE_CLEANUP_MODE` (`src/types.ts`, `wrangler.jsonc` default `"dry-run"`) — only an explicit `"execute"` deletes; unset or invalid fails closed to dry-run; the mode never comes from the request body. Default dry-run is deliberate: after deploy the endpoints inventory only; the owner step is flipping the var to `"execute"` and redeploying, then POSTing the cleanup (or letting the next owner login clean the stranded id).

## Test evidence
- TDD Red: `tests/iaaa_stale_cleanup_6236.test.ts` failed to load before the implementation (the new module did not exist). Green after: 13/13 — dry-run inventory names every stale item and deletes nothing; execute deletes the stale alias rows + reverse entry, keeps the forward pointer and the live binding, audits once per deletion; orphan/corrupt rows and orphan reverse entries are never deleted; an active grant under a retired id is reported, never deleted; an audit failure is named and never stops the pass; both live owner identities are byte-identical when nothing is stale; the targeted stranded pass deletes only the stranded id's rows and never a login row already pointing at the derived id; `currentBootstrapEntries` keeps the `platform,tenant:` role list; `isPlatformBootstrapListed` matches a retired bare id through its migration record.
- Affected existing suites green: `bootstrap_proposals_3077`, `iaaa_bootstrap_roles`, `iaaa_github_end_to_end`, `iaaa_genesis_per_identity`, `iaaa_admin_overview`, `iaaa_admin_api` (68 tests).
- Typecheck: `npm run typecheck` clean.
- Tier 1: `scripts/verify-tier1.sh` — [STATUS TO FILL].

## Risk
- Destructive by design, but gated twice: execute mode is opt-in (default dry-run) and deletion requires a provable forward pointer + no live binding. The two live owner identities produce no cleanup item by construction (pinned by test). Revoked records are never deleted. A misclassification deletes an alias row or reverse entry — recoverable: the binding (by-provider record) and the `migrated:` pointer are never deleted, so the next login re-derives the id and re-records the alias.
- New routes are additive; no existing route behaviour changes except the bootstrap current-list/propose resolution (bug fix, pinned by existing tests) and the login-path best-effort stranded cleanup (execute mode only).

## Delivery
- Branch `fix/6236-remove-stranded-stale-ids`, head `ba7919cdd1d0707fd4704fb90059058a70f3c051`.
- Rebase-and-merge by the coordinator after CI green (do NOT merge from this lane).
- Owner step after deploy: flip `IAAA_STALE_CLEANUP_MODE` to `"execute"` + redeploy, then `POST /api/iaaa/stale-identities/cleanup` as platform-admin (or wait for the next owner login, which cleans the stranded id); verify live via the browser: login path + Users view resolve to derived ids, bootstrap proposals show no "Unresolved" for the owner identities, Role grants still show both identities with both roles active.

## Evidence
- CHANGELOG.md [Unreleased] entry in this PR.
- No conflict markers in the diff or on main (grep `<<<<<<<` / `>>>>>>>` clean).
- Claim: branch-as-lock `fix/6236-remove-stranded-stale-ids`, claim comment on #6236.

## Checklist
- [x] Issue-first, branch + PR only, rebase from fresh main before editing and before pushing
- [x] TDD Red→Green; no failing test deleted to go green
- [x] CHANGELOG.md [Unreleased] entry in the same PR
- [x] No conflict markers in diff or main
- [x] No Copilot; Dependabot untouched; no old deploy re-run
- [x] Config switch for the behaviour change; invalid fails closed to default
- [x] No new store, no new capability duplicated (reuses the alias/migration/binding/membership stores and the audit funnel)

Reuse class: new
Dependencies: none
Process documentation impact: none (no delivery-process change; no ADR — no new architectural decision, the cleanup reuses the existing alias/migration/binding stores and audit funnel)
Out of scope: #6235 (Yahoo feed skip RCA); the Users-view index-drift fix (sibling issue — this PR only removes the stale rows the Users view resolves through); the mas_events / Audit Vault canonical-store question (#5264); any change to the env bootstrap list itself (owner-managed — the app now resolves retired bare ids forward at read time)

## Agent
#CISO-bhdm
