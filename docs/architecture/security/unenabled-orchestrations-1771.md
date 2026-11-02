# Unenabled orchestrations — enable-or-decide record (#1771, parent #1717)

Lane: #CISO-bhdm. Source rows: F-45, F-46, F-51 partial, F-54 partial
(scan doc `docs/compliance/system-duplicates-scan-1717.md` + appendix).
The machine-readable record is `src/orchestrations/orchestrationStatus.ts`;
this doc is its human-readable companion and is updated in the same PR
whenever a slice flips an entry. Nothing here is a new surface: every
evidence path names a file already on main, and every "enabled" claim
names the gate that stays in front of it.

## Hard guard

No orchestration in #1771 bypasses the manual trade-approval gate, nor
any other control. Proposal-only engines produce DRAFT data for the
existing approval workflow; they place, preview, and submit nothing.
The registry enforces `tradeApprovalBypass === false` on every entry
in tests (`tests/orchestration_status_1771.test.ts`).

## Per-orchestration status (slice A)

| Orchestration | Status | Blocker / terms |
|---|---|---|
| Autonomous portfolio rebalancing | Deliberately unenabled (slice C builds it) | No engine on main — only a UI action-type label. Slice C: DRAFT-only drift proposals, never autonomous execution. |
| Cross-agent P2P x402 micro-payments | Enabled, gated | Testnet (base-sepolia, no real money) + simulated paths only; simulated proofs rejected by verifyPayment. Mainnet real-money P2P is NOT activated — owner decision. |
| Multi-leg spread repair engine | Deliberately unenabled | No multi-leg fill-state source; existing `repairProposals.ts` is single-stock underwater repair (DRAFT, #355), not a spread engine. |
| Cross-venue E*TRADE-vs-Alpaca arbitrage | Deliberately unenabled | E*TRADE Connect is an owner action (#1066); no live dual-venue pricing/fees/balance source. Catalog arbitrage entries are single-venue templates. |
| Multi-agent swarm cross-screener consensus | Deliberately unenabled (slice B builds it) | No swarm routing/consensus harness; orchestrator Judge routing serves single chat turns. Slice B: pure consensus harness, DRAFT set + dissent, never trades. |
| Continuous volatility / dark-pool arbitrage monitor | Deliberately unenabled | `flowService.ts` has NO trade tape (audit F17: modelled estimates only); no licensed dark-pool feed. Point-in-time volatility gating (#1769b) already exists; the continuous monitor waits on a real tape/feed owner decision. |
| Social feed wiring (screener digest → brief) | Decided (slice D builds the mechanism) | Opt-in digest source behind one scoped switch, default human/NLQ brief only; human brief always wins, never overwritten; digest brief provenance-marked; live publish stays approval-gated; #1224 pipeline gates byte-identical. |
| Goal-to-goal chaining support | Enabled (already; not rebuilt) | `chain.execute` governed firing in ScheduledAgent (`#1517`/`#1523`), modes in `goalChainModes.ts` (#1729). |
| Closed-loop screener-to-trade | Enabled, gated | Screener output feeds reports/proposals; execution only via the trade workflow's await-approval event. The gate is part of the loop. |

## Reflection / self-tuning decision (F-45, F-54)

**Decision: reflection logs stay developer-mediated. They do NOT mutate
code or prompts, and #1771 builds no auto-apply path.**

Rationale: self-mutation would bypass the branch + PR + green gate
change-control path (including Policy Gate) that every other change
must take, with no owner-approved guardrail design on record for an
agent rewriting its own code or prompts while remaining attributable.
The existing loop preserves the human gate: `src/services/reflection.ts`
proposes (pending strategy-review candidates under the REFLECTION
pseudo-symbol, `quant_status` "unverified"); the human disposes.
Any future self-mutation proposal must arrive as its own issue with a
guardrail design and an owner decision — it is not smuggled in here.

## Excluded (reference only)

Pipeline goals themselves are CLOSED #1224 (TDD-first, gates
byte-identical) — not re-filed, not rebuilt. The open part in #1771
was ONLY goal-chaining support (enabled, above) and the social-feed
digest wiring decision (decided, above).
