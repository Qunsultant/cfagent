# Goals 2–4 scope — grounded 2026-10-28

Sources read in full: #2020, #2021, #2022 (program stubs), #1623 (CPO
lane, open), #1076 (full text, 15k chars). Code reality checked
against the repo where a scope claim depends on it.

## Goal 2 — #2020 subscription, entitlements, credits (builds on #1623)

#1623 (CPO-dhmp lead, CTO + CDO contributing) wants: plans, usage
metering (requests, scans, reports, users, API calls, agent runs, data
consumption), feature entitlements, billing hooks. Acceptance: a
metered run accrues usage (tested); an unentitled feature refuses
cleanly; free/pro caps enforced. #2020 adds: tier object, per-user
tier attribute, included usage, free/pro caps, credit earn/vest/redeem
rules. The simulated $50 local-ledger wallet (#122) is NOT referral
credit and must not be conflated with it.

- **Gated on the account-store decision (same gate as #2015).** The
  tier object + per-user attribute + credits store ARE the store.
  Building #2020 means building the store (or waiting for #1623's).
  No honest slice of #2020 exists that doesn't touch the store.
- **Owner decisions still open (not code):** subscription price(s)
  and included usage; credit earn/vest/redeem rules; tier names;
  free-tier limits; whether the simulated wallet ledger becomes the
  credits ledger or credits get their own store.
- **Not buildable as "pure modules" without a caller.** #1076's
  acceptance rule applies: no item is done from a draft, a module, or
  a defined-but-uncalled path — acceptance requires the live route +
  verification. Pure tier/credit rule functions with no store to read
  or write would violate that standard, so they are not a shortcut.

## Goal 3 — #2021 cancellation, refunds, lifecycle email (builds on #1076 B1/B3)

- **Cancellation: gated on #2020.** No subscription object exists, so
  cancellation is not expressible, let alone executable. Once the
  object exists: self-service cancel = downgrade to Free (full-list
  mail stops, limited mail continues; already-paid pay-per-use calls
  unaffected). Scope note from #1076: "cancellation" here means
  subscription cancellation, not cancelling scheduled jobs/orders
  (separate item if wanted).
- **Refunds: gated on owner policy + #2020 object.** Gateway
  `executeRefund` EXISTS (Stripe/PayPal/LemonSqueezy/Sandbox) for
  gateway payments, but refund windows/proration per model are
  undefined in code — a capability needs the policy before the route.
  cfpay cannot refund at all, so cfpay-payment refunds need their own
  rail and policy before any refund route is promised (#2024, deferred
  after the Goal 1 pilot, is the same gate).
- **Lifecycle email: partially buildable, but not the priority slice
  without a steer.** Sending exists (`env.EMAIL.send`, cfpay A2A
  email). Missing: welcome trigger on first provisioning (A1, must be
  best-effort, never blocking provisioning), opt-in daily digest with
  per-day durable guard + skip-on-empty (A2, default off), preference
  store + signed one-click digest unsubscribe (A3, security mail
  non-suppressible). Content selection is tier-dependent (Free →
  limited-candidate email, Subscribed → full), so a digest built now
  would be limited-only until tiers land — coherent, but the
  dependency order in #1076 is subscription + referral-credit system
  FIRST, limited-candidate email second (the email links to both).
  Building email before the store inverts that order; scope it, don't
  start it unprompted.

## Goal 4 — #2022 ads tier rule + revenue observability

- **Ads rule: the one independently buildable slice.** #2022's text
  already states the rule: ad-free follows active Subscribed status
  only, enforced server-side on every surface. (#1076's open edge —
  whether pay-per-use alone confers ad-free — is answered by that
  same rule: no, Subscribed only.) Today the ad system has NO ad-free
  concept: `mas_ads` served top-20 by clicks with impression
  increments, `mas_external_ads` Google units under a CLIENT-side
  toggle (default ON) — so any free user can already switch ads off.
  Enforcement points: the ads endpoint (return empty list + record no
  impressions for paid-tier callers) and banner config resolution
  (server-side disabled + Google units off for paid tiers, covering
  every per-tab surface the config gates; the client toggle remains
  only as a Free-tier preference). The slice needs no store to be
  correct: a tier lookup that returns Free when no tier record exists
  is exactly right today, and stays right when #2020's store lands
  (the port's implementation swaps from absent→Free to reading the
  store). This is the recommended next build after the store
  decision, or alongside it.
- **Revenue observability: buildable once family is structured.**
  "Revenue per family, per run, per coverage type, with measured
  cost-per-run visibility." The #2019 ledger rows ARE the revenue
  data (charge/credit rows, amounts, run ids), but family is only in
  the charge row's free-text note — no dedicated column, and the
  `payment.confirmed` audit payload carries price + run id but not
  family. A revenue report needs either family in the audit payload
  (small adapter amendment — PR #2089 is still a draft, so it can
  carry it) or a join from run id to run records. Cost-per-run
  visibility additionally needs a cost side that does not exist yet
  (no per-run cost accounting in the repo) — that half is a design
  question, not a report query. Do not promise cost-per-run until the
  cost side is defined.

## Order that respects the dependencies

1. Account-store decision (blocked item) → unlocks #2015, #2020,
   cancellation (#2021), and the tier-dependent halves of email/ads.
2. Ads server-side enforcement (buildable independently; needs no
   store, correct under Free-default).
3. Revenue report (needs family structured in audit payload or a
   run join; cost-per-run needs a cost-side design first).
4. Cancellation route + refund routes (need #2020 object + owner
   refund policy; cfpay refunds need a new rail, not a route).
5. Lifecycle email (needs subscription + referral-credit system
   first, per #1076's dependency order).
