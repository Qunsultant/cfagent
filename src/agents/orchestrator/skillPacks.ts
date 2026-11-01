/**
 * Issue #2705 (Agents SDK Skills enablement, slice 1; owner
 * direction 2026-11-01 executing #2460's adopt-as-packaging
 * recommendation) — OrchestratorAgent's Agent Skills sources,
 * extracted from the class in the #992 pattern. The class gains a
 * thin getSkills() delegation; this module owns the source.
 *
 * ONE source: an in-repo code-manifest source (the Agents SDK
 * skills.manifest factory — the module @cloudflare/think itself
 * imports and re-exports as its skills namespace). No R2 source,
 * no workspace source, no new binding: a skill is instructions
 * the model follows, so the source is a trust decision, and the
 * in-repo shape keeps every pack under repository review (the
 * #2460 assessment's control point: source write-access).
 *
 * ONE pack: chat-screening-doors, the door-playbook pack for the
 * chat screening doors (run_stock_screen, #2488;
 * run_options_strategy_screen, #2581). The canonical pack text is
 * the SKILL.md beside this module
 * (skills/chat-screening-doors/SKILL.md, with its examples.md
 * resource); the manifest entry below is DERIVED from that text
 * by the SDK's own parser at module load, so the served entry
 * cannot drift from the reviewed file — and the slice's suite
 * pins the embedded copy equal to the file byte-for-byte.
 *
 * Think re-lists sources before every turn; with a non-empty
 * catalog its turn assembly adds activate_skill and
 * read_skill_resource to the turn's tool set. No skill script
 * runner is configured anywhere in the fleet, so run_skill_script
 * stays absent.
 */

import { manifest, parseSkill } from "agents/skills";
import type { SkillManifestEntry } from "agents/skills";
import type { SkillSource } from "../../actors/thinkAdapter";

/** The one code-manifest source OrchestratorAgent serves. */
export const CHAT_SCREENING_SKILLS_SOURCE_ID = "cfagent-code-manifest";
/** The one pack the source serves in this slice. */
export const CHAT_SCREENING_PACK_NAME = "chat-screening-doors";

/** Canonical pack text — skills/chat-screening-doors/SKILL.md, verbatim. */
export const CHAT_SCREENING_DOORS_SKILL_MD = `---
name: chat-screening-doors
description: "Use when a chat user asks to run a stock screen or an options strategy screen — for example a NASDAQ100 bull put credit spread with max-loss and min-profit bounds. Covers the chat screening doors run_stock_screen and run_options_strategy_screen: door selection, how each door behaves, identity carriage, refusal codes, and the never-deflect rule."
---

# Chat screening doors — playbook

## When this applies

A user in chat asks to screen stocks over a universe, or to screen
options strategies with constraints (a strategy, a universe, loss and
profit bounds, expiry bounds). Two mesh doors serve these requests in
the turn: 'run_stock_screen' and 'run_options_strategy_screen'
(surfaced in the turn as the openaimp door tools). This pack is the
procedure for using them well. It is guidance for the turn; every
rule it describes is enforced by the doors themselves, in code.

## Door selection

- Stock screen over a universe (which stocks match, possibly with
  filters): use run_stock_screen.
- Options strategy screen (which strategy trades match constraints
  such as max loss, min profit, days to expiry): use
  run_options_strategy_screen.
- A listings-style filter scan (by RSI, market cap, sector, price,
  gainers or losers across listings) is a different tool
  (etrade_market_scan), not one of these doors. Do not force a
  strategy request into it, and do not force a listings scan into
  the strategy door.

## run_stock_screen — job carriage

- The door starts a ScreenerScreenWorkflow run and awaits it on a
  bounded poll. The run carries a job id of the shape
  'screener:chat:...'. The door returns the run's outcome, or — if
  the await bound expires — an honest tracked status pointing at
  the run's status surface. Never invent a result the read-back did
  not return.
- Universe is an explicit parameter over the registry universe set
  and defaults to NASDAQ100 when the user names none. An unknown
  universe name is refused, never guessed.
- Mode is deterministic by default. Non-deterministic mode is a
  per-run selection (screenMode 'non-deterministic' plus a
  screenIntent — the free-form intent the run interprets into
  criteria). An intent supplied without that mode is refused, not
  silently ignored.
- The paid variant of a screen follows a fixed fail-closed order:
  catalogue price, budget check, checkout email, account
  resolution, payment submission — one charge per run-request,
  and the run id is the payment's run id. Any step that cannot
  complete refuses the run before it starts.

## run_options_strategy_screen — direct return

- The door runs the options strategy engine's scan inline and
  returns the result directly. There is no workflow and no job:
  the scan is a single engine call over one symbol batch, bounded
  by the engine's scan cap.
- strategyType takes a strategy from the engine's catalog — an id,
  a label, or an alias (for example 'Bull Put Credit Spread'
  resolves to the put credit spread). Anything that does not
  resolve is refused before any engine call.
- Map the user's words onto the structured parameters: maxLoss is
  the maximum planned loss per position; minProfit is the minimum
  max profit; minDte and maxDte bound days to expiry when given.
  State the bounds the user stated; never tighten or loosen them
  silently.
- Universe defaults to NASDAQ100. 'ALL' is refused by this door:
  it names a sharded stock-screen fan-out, and this scan is a
  single batch. Ask for a concrete universe instead.
- An empty scan is a normal result, returned as an honest
  no_opportunities payload. Report that no opportunities matched
  the constraints. It is not an error, and it is not a reason to
  retry with loosened constraints unless the user asks.

## Identity carriage

- The doors execute as the turn's acting identity — the signed-in
  user's login, stamped server-side by the platform. An identity
  is never a tool argument: do not supply one, invent one, default
  one, or reuse another user's.
- With no resolvable acting identity the door refuses with
  identity_required before anything runs. Surface the refusal;
  never work around it.

## Refusal codes — what they mean and what to do

Every refusal is coded and raised before anything starts or is
charged. A refusal is the answer, not an obstacle: surface it in
plain language, state that nothing was started or charged, and
stop. Never retry a refusal by rewording the same request, and
never report results the door did not return.

- identity_required — no acting identity, or the retired synthetic
  identity was presented. The turn itself lacks an identity; do
  not retry.
- door_unavailable — the door's backing surface is unavailable or
  misconfigured, a universe name the door does not take, or an
  empty symbol batch. Report it; do not guess a different universe.
- invalid_strategy_type — the strategy does not resolve against
  the engine's catalog. Ask for, or map to, a catalog strategy;
  never invent one.
- nd_mode_unavailable — non-deterministic mode was requested while
  this deployment has it off. Never silently downgrade to a
  deterministic run; say the mode is unavailable, and run
  deterministically only if the user agrees.
- screen_intent_required — non-deterministic mode without an
  intent, or an intent supplied without the mode. Ask for the
  intent, or drop it; an intent is never silently ignored.
- budget_denied — the budget door refused the paid path. Report
  the refusal; do not split the request to evade the budget.
- price_unavailable — no stored catalogue price exists for the
  paid run. Do not fabricate a price.
- checkout_email_required — a chat turn has no checkout email
  source, so the paid path cannot complete. Report the honest
  stop; do not claim a charge or a completion.

## The never-deflect rule

A stock screen or options strategy screen request in chat is
served here, by these doors. Never tell the user the capability
is handled through a UI workflow, another tab, or any other
surface — that deflection is the failure this playbook exists to
prevent. If a door refuses, report the coded refusal; the request
is still not deflected.

## Worked examples

The bundled resource 'examples.md' maps example requests to door,
parameters, and expected outcomes. Read it with
read_skill_resource when a request's shape is ambiguous.
`;

/** The pack's bundled resource — skills/chat-screening-doors/examples.md, verbatim. */
export const CHAT_SCREENING_DOORS_EXAMPLES_MD = `# Worked examples — chat screening doors

## 1. Options strategy screen (direct return)

User: "Screen for bull put credit spreads in the NASDAQ100 with
max loss <= $30 and my max profit greater than $0."

Door: run_options_strategy_screen.
Parameters: strategyType 'Bull Put Credit Spread' (a catalog
label; resolves to the put credit spread), universe NASDAQ100,
maxLoss 30, minProfit 0.
Outcome: the scan runs inline and returns the matching
opportunities, or an honest no_opportunities result if none match.
Never deflect this request to a UI workflow.

## 2. Stock screen (job carriage)

User: "Run a stock screen over the NASDAQ100."

Door: run_stock_screen.
Parameters: universe NASDAQ100 (also the default when the user
names no universe).
Outcome: a ScreenerScreenWorkflow run starts under a
'screener:chat:...' job id; the door awaits it and returns the
run's outcome from the canonical read-back — not a result invented
at start time.

## 3. 'ALL' on the strategy door (refused)

User: "Scan ALL universes for iron condors."

Door behavior: run_options_strategy_screen refuses 'ALL' with
door_unavailable — a single inline scan cannot fan out over a
sharded universe set. Ask which concrete universe to scan, or, if
a listings-style scan over ALL is what the user wants, that is
the market scan tool, not this door.

## 4. Non-deterministic mode while disabled (refused)

User: "Screen stocks, interpreting what I mean in AI mode."

Door behavior: if the deployment has the non-deterministic
screener mode off, run_stock_screen refuses with
nd_mode_unavailable. Do not downgrade silently: tell the user the
mode is unavailable in this deployment and offer a deterministic
run only as their choice.

## 5. Unknown strategy (refused before any engine call)

User: "Find me some moonshot butterfly ladders."

Door behavior: if the named strategy does not resolve against
the engine's catalog, run_options_strategy_screen refuses with
invalid_strategy_type. Offer the catalog strategies the engine
actually has (by id, label, or alias); never invent a strategy.
`;

const parsedPack = parseSkill(CHAT_SCREENING_DOORS_SKILL_MD, {
  directory: CHAT_SCREENING_PACK_NAME,
});
if (!parsedPack.ok) {
  throw new Error(
    `chat-screening-doors pack does not parse: ${parsedPack.error.message}`,
  );
}
if (parsedPack.warnings.length > 0) {
  throw new Error(
    `chat-screening-doors pack parses with warnings: ${parsedPack.warnings
      .map((w) => w.message)
      .join("; ")}`,
  );
}

/**
 * The manifest entry served for the pack, derived from the
 * canonical SKILL.md by the SDK parser (frontmatter name and
 * description, body instructions) plus the bundled examples
 * resource.
 */
export const CHAT_SCREENING_DOORS_PACK: SkillManifestEntry = {
  name: parsedPack.value.name,
  description: parsedPack.value.description,
  body: parsedPack.value.body,
  resources: [{ path: "examples.md", content: CHAT_SCREENING_DOORS_EXAMPLES_MD }],
};

/**
 * OrchestratorAgent's getSkills() result: exactly one in-repo
 * code-manifest source holding exactly the one pack.
 */
export function buildOrchestratorSkillSources(): SkillSource[] {
  return [
    manifest({
      id: CHAT_SCREENING_SKILLS_SOURCE_ID,
      skills: [CHAT_SCREENING_DOORS_PACK],
    }),
  ];
}
