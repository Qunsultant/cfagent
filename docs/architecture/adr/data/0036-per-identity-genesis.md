# 0036. Per-identity genesis: one entry per user, explicit roles, configurable one-time rule

- Status: accepted
- Date: 2026-11-22
- Deciders: owner (Mubasher)
- Issue: #6191 (sub-issue of #945)
- Implementing PR: (this PR)

## Context

Genesis — the first platform-admin grant from the bootstrap list
(`IAAA_BOOTSTRAP_ADMINS`) — was global-once: `performGenesis`
claimed a single marker per tenant
(`iaaa-bootstrap:platform-genesis:<tenantId>`) with `putIfAbsent`,
so once ANY identity claimed it, every later `platform:`-listed
identity was refused ("genesis marker was claimed concurrently").
The owner's Google login
(`platform:https://accounts.google.com:116080816274398642624`)
could therefore never mint platform-admin, and the owner was left
with a single live platform-admin whose membership had been revoked
(2026-10-23) — a deadlock: platform-admin grants need a live
platform-admin plus a second distinct approver, and none was live.

The same user also appeared twice in the list
(`platform:https://github.com:82253453` for genesis → platform-admin,
and plain `https://github.com:82253453` for bootstrap →
tenant-admin), because the two roles were granted by two separate
branches. And the `platform:` prefix silently also granted
tenant-admin — the entry never SAID both roles.

The one-time rule itself was hardcoded. The owner directed (2026-11-22):
fix genesis itself (do not build a parallel mechanism — #6190, the
config-file solution, was closed as superseded); remove the one-time
requirement and make it configurable; roles must be explicit in the
entry; one entry per user; a revoked platform-admin must be restorable
on login; and all SessionStore settings must be externalized.

## Decision

### Per-identity genesis (default), global-once behind config

Genesis is per-identity by default: each listed identity claims its
own marker
(`iaaa-bootstrap:platform-genesis:<tenantId>:<internalUserId>`)
on its first wired login. A claim by one identity never blocks
another's. The same identity never double-mints: the claim is still
atomic (`putIfAbsent` before the grant, #1756), scoped per identity.

The one-time rule is a config setting, not hardcoded:
`config/sessionstore.json`, `genesis.oneTime` (boolean, default
`false` = per-identity; `true` = the legacy global-once behaviour,
preserved byte-for-byte behind the setting, including the #1208
stranded-marker repair, which only applies in global-once mode).
An operator overrides it by changing config and redeploying — no
code change. An invalid value fails closed to the default
(per-identity) with a named error, never to an open grant.

Why a per-identity marker and not re-runnable genesis: without a
marker, two concurrent first-logins of the same identity could both
pass the "already holds platform-admin" check and both mint — the
exact race #1756 fixed. The per-identity marker keeps
claim-then-grant atomicity, scoped per identity.

### Explicit roles in the entry

The entry format gains an explicit role list:
`<role>[,<role>]*:<identity>`, roles `platform` / `tenant`. The
parser grants exactly the roles named and rejects an unknown role
with a named error. A `platform:`-only entry grants platform-admin
only — it never silently grants tenant-admin; a loser of a
global-once race with a platform-only entry gets the named status
`genesis-claim-lost` and no membership. A `tenant:`-only entry (or a
plain entry, kept for backward compatibility) grants tenant-admin
only. A list containing the same identity twice is deduped by
MERGING roles (union, canonical order platform-then-tenant) with the
dropped duplicate named in `rejected` as a warning — a hard reject
of the whole list was rejected as the choice, because one typo would
brick ALL bootstrap provisioning.

The list after this change — one entry per user, both roles explicit
for both identities:

```
platform,tenant:https://github.com:82253453,platform,tenant:https://accounts.google.com:116080816274398642624
```

The plain duplicate `https://github.com:82253453` is removed.

### Restore on revoke

A `platform:`-listed identity with a REVOKED platform-admin
membership gets a fresh live one on login: when the marker names
this identity AND a non-live platform-admin membership proves a
grant landed once, the spent claim is deleted and the atomic claim
retried, so concurrent restorers produce exactly one grant. The
revoked record stays as history — a revoked membership is never
un-revoked. A user with NO platform-admin membership at all has
nothing to restore from (that is a first grant, not a restore).

### SessionStore settings externalized

`config/sessionstore.json` is the single place an operator tunes
the SessionStore (`src/config/sessionStoreConfig.ts` resolves it;
the repo's config-file convention, same as
`config/session-limits.json` + `src/config/sessionLimits.ts`).
Externalized in this slice:

- `audit.liveMax` 2000, `audit.segmentSize` 2000,
  `audit.maxSegments` 10 (the #1760 audit-append ceilings — a
  client may request SMALLER caps, never larger; the bound is
  enforcement, not a caller preference).
- `genesis.oneTime` false (this decision).
- `schemaVersion` 1 (discipline unchanged: bump ONLY alongside a
  `kv_store` schema change under runDoSchemaMigration, ADR 0022
  D-A.4).

Each setting has a documented default (its current value) and a
named error on an invalid value, failing closed to the default.
A config/UX surface for editing these values is a separate slice —
this slice externalizes them, it does not build the editor.

NOT tunables, staying in code (inventoried in the #6191 RCA):
TTL/expiry (the DO has NO TTL default — `put`/`consume` honour the
client's `ttl`; the TTL VALUES are already externalized in
`config/session-limits.json`); the field-length `MAX_FIELD_LENGTH =
512` (an IAAA input-validation constant duplicated across
authorization/agentAccess/delegation/executionContext/iaaaAudit/
iaaaBootstrap — consolidating it is a separate #1717 slice);
policy (audit-append/list namespace+key restriction, list
restriction, `consume` replay guard, expired-read delete);
format/unit (`ttl * 1000` seconds→ms, `padStart(6, "0")` key width).

## Consequences

- The owner's Google sign-in mints platform-admin on first login
  after deploy — a second live platform-admin. The GitHub sign-in
  is unchanged (it already holds platform-admin; the top-up grants
  tenant-admin explicitly now, via the `tenant` role in its entry).
- The bootstrap-status element (`platform-genesis`) is now
  membership-based, not marker-based: present when every
  platform-listed identity holds live platform-admin, missing
  while any listed identity has not yet claimed. The IAAA Admin
  Overview's `platformGenesisOccurred` is marker-based (the
  caller's own per-identity marker or the legacy global marker);
  KvLike has no list, so another identity's per-identity marker is
  not visible there — a named gap, not a silent false negative in
  the other direction.
- The clean-state wipe deletes the legacy global marker AND all
  per-identity markers for the tenant (both the data-lifecycle
  `markerPlan` and the kvWipe `marker` row): a memberships wipe
  without clearing them would strand the markers (the memberships
  are deleted, not revoked, so the restore rule cannot fire) and
  lock platform-admin out on the next owner login.
- Global-once mode is preserved for any operator who wants the old
  behaviour; it is the only mode in which the #1208 repair runs
  (the stranded Oct 22 marker lives on the global key, which the
  per-identity path never reads).
- Unchanged: the bootstrap path still grants tenant-admin only
  (it is now also invoked for `platform:` entries' tenant top-up);
  the self-grant rule, the two-approver admin-grant flow (#3155),
  the grant path, and the Q9 grant rules are untouched. #6182 (the
  #1182 migration trigger) is a separate mechanism and is not
  touched here. #6195 (consistent vocabulary — genesis retired as
  a term, bootstrap is THE term) builds AFTER #6191 merges and
  renames nothing here.
