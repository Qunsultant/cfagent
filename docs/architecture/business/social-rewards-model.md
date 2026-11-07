# Social rewards — reward model + ledger alignment

- **Issue:** #3477 (parent program #3476) — "Reward model + ledger alignment: types, accumulation, expiry, daily/monthly caps"
- **Status:** MODEL DEFINED. This document is the deliverable #3477 asks for: the reward model written down with types, accumulation/expiry/cap rules, ledger mapping, and stacking rules. It is **not** a production config change, **not** a flag change, **not** a price change, and **not** a secret or permission change. Every value in it is owner/CBO-decided and unset (null) until configured; nothing here asserts a default.
- **Verified against:** `origin/main` = `67cea938`. The ledger facts were verified against `src/data/lifecyclePorts.ts` (referral rules, earnings, attribution), `src/services/referralCredits.ts` (earn/vest/redeem + commercial conversion), `src/data/freeRunCounterPorts.ts` (#3305), `src/data/subscriptionPorts.ts` (trial #3243 / operator grant #3245), `src/data/productMarketing.ts:307` (channels).
- **Executable form:** `src/data/socialRewardModel.ts` (pure rules, port-first) + `src/config/socialRewardLimits.ts` + `config/social-rewards.json` (all values null). The doc states the model; the code pins it; neither invents a value.
- **Parent program:** #3476 (social rewards). Related: #2012 (commercial program, canonical), #2208 (referral-credit ledger), #2657 (attribution), #3305 (free-run counter), #3243 (trial), #3245 (operator grant), #3307 (invite codes), #3483 (externalized configuration surface), #3484 (management UX), #3478–#3482 (per-platform + notifications slices).

## 1. The requirement (user direction 2026-11-06)

> Reward users who like, share, and subscribe to the platform on social media — with grants, free runs, and free months — and reward both sides of an invite. Rewards may accumulate, but they expire; only a certain number may be used per day and per month; unused rewards expire. All values, caps, expiries, and toggles are externalized configuration, never hardcoded. Everything is manageable through UI.

Program rules that bind this model (from #3476):

- Actions rewarded: like, share, subscribe on each social platform; invite codes reward BOTH users (inviter and invitee).
- Rewards: grants, free runs, free month (and equivalents); values are owner/CBO decisions, never defaulted.
- Accumulation: rewards may accumulate, but they expire; only a certain number may be used per day and per month; unused rewards expire.
- No dark patterns. Trading stays approval-gated and is never monetized.

## 2. Reward types and what they map onto

| Type | What it is | Maps onto (existing mechanism) |
|---|---|---|
| `credit` | A USD credit grant, vested after a delay, expiring after a window. | The referral-ledger RULES: earn → vest → oldest-first allocation → conversion into commercial credit → the existing gate coverage (`src/services/referralCredits.ts`). The conversion path is shared; the earning records are NOT. |
| `free-runs` | A grant of N runs. | The free-run counter (#3305) as a SEPARATE BUCKET (see §4). |
| `free-month` | One period of a plan, free. | The operator subscription grant / trial (#3243/#3245): a $0 checkout, provider "trial", status "trialing", or an operator-granted subscription period. |

### 2.1 What is never conflated

- **Social credit is never recorded as referral credit.** Referral earning rows (`agent_referral_earnings`) are keyed one-per-referred-user (`referral:<referredUserId>`) and carry referrer/referred semantics. A social grant is per (user, action, platform, UTC day) and accumulates — the keying does not fit, and writing social grants into referral rows would corrupt referral attribution and double-count. The social earning record shape is defined in §6; its store arrives in a later slice (no migration in #3477).
- **Social credit is never failure-credit compensation.** Referral credit is kept deliberately separate from the D1 failure-credit claims (`agent_credit_claims`) and from the simulated $50 wallet credit (#2208). Social credit joins that separation: it is its own earning kind, redeemable only through the conversion path (§3.3), never by spending directly on a run (that would be a parallel payment bypass around the gate — the same rule that binds referral credits).
- **Social runs never extend the free-run allowance.** See §4.

## 3. The rules

### 3.1 Accumulation

Rewards accumulate as separate records. There is no merging of grants: each verified action mints its own grant record, and redemption consumes oldest-first (§3.4). One grant per (user, type, action, platform) per UTC day — a second verified same action on the same day is a replay that returns the existing grant, never a second mint (idempotent-receiver rule; the grant id is `social:<userId>:<type>:<action>:<platform>:<YYYY-MM-DD>`).

### 3.2 Vesting and expiry

- Every grant carries `vestedAtMs = grantedAtMs + vestingDelayMs` (config) and `expiresAtMs = grantedAtMs + expiryWindowMs` (config).
- A grant vests exactly at `vestedAtMs` (`nowMs >= vestedAtMs`). A grant expires exactly at `expiresAtMs` (`nowMs >= expiresAtMs`) — at the instant of expiry it is gone.
- `expiresAtMs` is mandatory. A grant without expiry cannot exist: zero never means "no expiry" (the same rule as the grant-lifetime default in `src/security/grantRules.ts`).
- Expiry is evaluated at redeem time. Expired grants are never redeemable, and an expired grant is never allocated, even on shortfall.

### 3.3 Redemption

- Redemption is oldest-first over vested + unexpired grants with a positive unspent remainder (`redeemableGrants`). Partial redemption is tracked per grant (`redeemedAmountUSD` / `redeemedRuns`, the referral-ledger idiom); the remainder stays redeemable once vested.
- **Credit:** an exact run price is allocated oldest-first (`allocateSocialCreditRedemption`); a shortfall throws and allocates nothing — it never dips into unvested or expired credit. The allocated amount is converted into commercial credit (`adjustCredits`) and the run then goes through the EXISTING gate + payment workflow, exactly as referral conversion does. Partial balances are not converted: conversion covers an exact run price, and a balance below the price stays untouched.
- **Free runs:** a run count is allocated oldest-first (`allocateSocialRunRedemption`); a shortfall throws.
- **Free month:** a grant is applied whole, never partially.
- Every grant and every redemption is audited with code + login + tenant + type + amount/units + expiry (payload shape in §6; the audit call sites arrive with the wiring slices).

### 3.4 Caps

- Caps are per reward type, per user: `dailyCap` max uses per UTC day (`YYYY-MM-DD`), `monthlyCap` max uses per UTC calendar month (`YYYY-MM`, `freeRunMonthKey`). The day boundary is UTC (same grain as the digest guard, `digestDayKey`); the month boundary is the UTC calendar month (same as the free-run counter).
- Cap evaluation is daily first, then monthly. Exceeding either refuses with the coded `FAILURE_SOCIAL_REWARD_CAP_REACHED` (429, retryable — retryable after the window, and the message states when).
- Caps are configuration, never code. An unconfigured cap refuses (fail-closed, §5).

### 3.5 Verification and abuse

- **No grant without a verified action.** A grant mints only on a verified like/share/subscribe (or a verified invite redemption). An unverified claim never mints (`FAILURE_SOCIAL_REWARD_NOT_VERIFIED`, 422). No social-action verification exists yet — it is built by #3479–#3481 — so no grant can mint today. This is the anti-abuse rule, stated before any minting path exists.
- **No self-reward.** The actor and the beneficiary must differ (same rule as referral self-referral, which throws). Invite codes reward BOTH sides, but inviter ≠ invitee by construction.
- **Platform/action matrix:** like and subscribe are supported on facebook, instagram, threads only. Share is supported on all four marketing channels, including slack. Slack is a notification/delivery channel, never a like/subscribe platform (#3476).
- **Rewards must not become a way around the allowance cap by another name.** Enforced by the separate-bucket + allowance-first stacking (§4).

## 4. Stacking with the free-run counter, trial, and operator grants

### 4.1 Free runs: a separate bucket, allowance first

Decision: social free runs live in a **separate bucket** — counted, capped, and expiring on their own — and the run-coverage order is **allowance first, social bucket second**:

1. The free-run allowance covers a run first (when the (family, month) allowance has remaining runs).
2. The social bucket covers only when the allowance is exhausted for that family/month.
3. A run is never covered by both.

Why not the alternatives:

- *Counted against the allowance* would make the reward worthless the moment the allowance is exhausted — the reward would not be a reward.
- *Exempt from counting* would let rewards bypass the allowance cap by another name — explicitly forbidden by #3477.

The bucket is keyed (tenant, user, family, period) with its own daily/monthly caps and expiry (§3). The allowance cap still applies to every non-social run, and the social bucket is itself capped — so the total free runs in a month can never exceed allowance + social bucket, and each side is bounded.

### 4.2 Free month: no double free period

A free-month grant is issuable only when the user holds **no active paid subscription and no active free period** (trial or operator grant). Otherwise the grant WAITS — and its expiry still applies, so a grant that expires while waiting is lost. A free month never double-grants, and never silently extends a paid period. Which account receives a free month first is an owner decision, recorded when the wiring slice lands.

### 4.3 Credit: the conversion path is shared, the rows are not

Social credit redeems through the same conversion path as referral credit (§3.3) — convert, then the gate covers the run. The earning rows stay separate (§2.1): referral rows stay referral-only, social rows are their own kind. A run that already got a replacement-run credit (failure-credit compensation) must not also be cash-refunded or social-covered — the #2549 XOR guard applies by analogy: one compensation per run.

## 5. Configuration (externalized, fail-closed)

- Every value lives in `config/social-rewards.json`, loaded and validated by `src/config/socialRewardLimits.ts`. The shipped file is ALL NULLS — every type unconfigured.
- Per-type config: `enabled`, `vestingDelayMs`, `expiryWindowMs`, `dailyCap`, `monthlyCap`, plus `amountUSD` (credit only) or `runs` (free-runs only). Cross-field misuse (an amount on free-runs, runs on credit) fails validation at load.
- Validation is strict: amounts are positive finite USD rounded to cents; delays are non-negative integers; expiry windows and caps are positive integers; `enabled` is boolean or null.
- **Fail-closed:** any required value null, or `enabled: false`, makes that type unavailable with `FAILURE_SOCIAL_REWARD_NOT_CONFIGURED` (503). There is no fallback value anywhere in code. The operator configures values through the #3483 surface when it lands; until then, rewards are unavailable by design (the same idiom as the cfpay channel's null fixed price).
- The channel list (facebook | instagram | threads | slack) is configuration, not code — a new platform is an owner decision + a new per-platform sub-issue, never assumed (#3476).

## 6. Records, identity, and audit

- **Grant record shape** (defined here; the store arrives in a later slice): `id, userId, tenantId, type, action, platform, amountUSD | null, runs | null, redeemedAmountUSD, redeemedRuns, grantedAtMs, vestedAtMs, expiresAtMs, redeemedAtMs | null, redeemedFor | null`. The spent portions track partial redemption (the referral-ledger idiom); `redeemedAtMs` is set only when the grant is FULLY redeemed. Eligibility is derived from these fields + `nowMs` (vested, unexpired, positive remainder) — no separate status field to drift.
- **Tenant scoping (#1069 §8):** every grant and redemption carries `tenantId`, resolved server-side from the session; a redeem whose tenant differs from the grant's tenant throws; no read is unscoped. Rewards are entitlements, and entitlements are tenant-scoped.
- **Audit payload (defined here; call sites later):** outcome code + login + tenant + reward type + action + platform + amount/units + `expiresAtMs` + grant id. The audit answers "which code, what happened, for which login" from the record alone (AOP fit-gap addendum acceptance).
- **Outcome codes** (all in `src/outcomes/outcomeCatalog.json`, category "commercial", resolved only through `src/outcomes/outcomeAspects.ts`): `SUCCESS_SOCIAL_REWARD_GRANTED`, `SUCCESS_SOCIAL_REWARD_REDEEMED`, `FAILURE_SOCIAL_REWARD_NOT_CONFIGURED` (503), `FAILURE_SOCIAL_REWARD_EXPIRED` (410), `FAILURE_SOCIAL_REWARD_NOT_VESTED` (422), `FAILURE_SOCIAL_REWARD_CAP_REACHED` (429, retryable), `FAILURE_SOCIAL_REWARD_NOT_VERIFIED` (422).

## 7. What this slice does NOT do (explicit non-scope)

- No store: no migration, no new tables. The social earning store is a later slice.
- No routes, no UI. The management UX is #3484; notifications are #3482.
- No verification: no like/share/subscribe verification exists (#3479–#3481 build it), so no grant can mint.
- No values: every config value is null. No prices, no discounts.
- No invite-code implementation (#3478 answers #3307).
- No caller: the model layer has no production caller yet. It is the contract the wiring slices will call. Nothing in this slice changes any user-visible behavior.

## 8. Open decisions (owner/CBO — never defaulted)

- Every config value: per-type amounts, run counts, vesting delays, expiry windows, daily/monthly caps, enabled flags.
- Which account(s) receive the first free month.
- Any new platform beyond facebook/instagram/threads/slack.
- Whether the social earning store reuses the referral tables with a kind column or gets its own tables (a later slice decides with the store change; the record shape in §6 is the same either way).
