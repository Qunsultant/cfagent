# Model/Prompt Registry + Eval Gates (MLSecOps, #769)

Parent program: #764. Gate dependency #767 is CLOSED (red-team eval set
exists); this slice wires the registry and the gates on top of it.

## Rule

Every model or prompt change is a pinned, recorded change that must pass
the behavior + security eval gates before merge, with results recorded
on the PR. A model-tier swap (see `docs/SYSTEM_CONFIG_TIERS_AND_MODELS.md`)
or a prompt edit lands like any other code change in every other respect
— and unlike any other code change, it is additionally gated here.

- **Registry (single diffable artifact):**
  `src/mlsecops/modelPromptRegistry.ts` — model ids + tiers, prompt
  template versions. There is no dashboard-only configuration for
  anything behavior-bearing; a change that exists only in a dashboard
  is not a change this registry can gate, and must not be made.
- **Gate:** `src/mlsecops/evalGate.ts`, exercised by
  `tests/mlsecops_model_prompt_gate_769.test.ts`, which runs in CI as
  part of the normal vitest suite on every PR. No separate workflow file
  is introduced by this slice: workflow files are owner-installed, so
  claiming a new workflow here would be a fabricated surface. The gate
  test file IS the CI gate — a PR that touches the registry or a pinned
  prompt builder runs it, and a red gate blocks merge under the
  named-failure rule.
- **Thresholds (fixed up front, not tuned per change):** security
  checks 100%, quality checks 100% (`EVAL_GATE_THRESHOLDS`). Changing a
  threshold is a diff to `evalGate.ts` in its own PR, never a per-change
  knob.
- **PR evidence (gitops §9 Test evidence):** model/prompt PRs attach
  gate results. A red gate blocks merge; no waivers without an
  owner-named exception recorded on the PR.
- **Rollback:** revert the pin in a single PR, recorded like any other
  change. Reverting a model pin restores the previous model id; reverting
  a prompt pin restores the previous template version and its gate
  expectations together — never one without the other.

## What the gate checks (and what it does not)

The gate runs at the **prompt-assembly level**: delimiters present in
exactly the expected count, the data-is-not-instructions rule present,
hostile payloads (including embedded END markers) never verbatim in the
assembled prompt, and legitimate content intact inside the delimited
region. This is the same level as the #767 v3 red-team manifest.

It does **not** grade live-model behavior ("does a live model obey an
injection despite the defense"). That is a separate, non-CI evaluation
by the #767 manifest's own statement, and this document does not claim
it. A green assembly gate is necessary, not sufficient, evidence about
a live model.

## Inventory (enumerated by grep + route inventory, 2026-10-25)

Model roles pinned (all from `environment.config.json`
`defaults.etapi.ai`): `default`, `reasoning`, and task models
`nlqPlanning`, `nlqValidation`, `optionsIdeas`, `optionsComparison`,
`orchestrator`, `marketResearch`, `searchAgent`, `newsSentiment`.
`checkModelPinsAgainstConfig()` fails on any drift between these pins
and the config, in either direction.

Prompt templates, with gate status at this slice:

| Template | Builder / source | Model role | Gate |
|---|---|---|---|
| newsSentiment | `buildNewsSentimentPrompt`, `src/trading/options/flows/newsSentiment.ts` (#881 defense) | newsSentiment | assembly-gated |
| optionsIdeasRanking | `buildRawOptionsIdeasRankingPrompt`, `src/trading/options/llmIdeas.ts` (#882 defense) | optionsIdeas | assembly-gated |
| orchestrator | `buildOrchestratorSystemPrompt`, `src/agents/chatPrompt.ts` (#879 retrieved-content defense; its rule text itself names the markers, so the expected delimiter count is 2, not 1) | orchestrator | assembly-gated |
| optionsIdeas | raw generation (`RAW_OPTIONS_IDEAS_SYSTEM_PROMPT` + caller userPrompt), `src/trading/options/llmIdeas.ts` | optionsIdeas | assembly-gated (#1763: INPUT_JSON fenced in `<<<UNTRUSTED_OPTION_DATA>>>`, END markers defused) |
| optionsComparison | `llmComparison` generation (`LLM_SYSTEM_PROMPT`), `src/trading/options/llmComparison.ts` | optionsComparison | assembly-gated (#1763: INPUT fenced in `<<<UNTRUSTED_COMPARISON_DATA>>>`, END markers defused; `comparisonPrompt` exported for the gate) |
| comparisonKernel | `buildComparisonPrompt`, `src/services/comparisonRunner.ts` | optionsComparison | assembly-gated (#1763: contract lines fenced in `<<<UNTRUSTED_COMPARISON_CONTRACTS>>>`, question defused) |
| nlqPlanning | planning generation, `src/agents/nlq/llmPlanning.ts` | nlqPlanning | assembly-gated (#1763: untrusted assembly — `plannerPrompt` + `UNTRUSTED_CONTENT_RULE` — gated; trusted chat/MCP path remains undelimited by design, see below) |
| nlqValidation | validation generation, `src/agents/nlq/llmPlanning.ts` | nlqValidation | assembly-gated (#1763: untrusted validation assembly gated on the same markers/rule as planning) |
| judge | routed generation (router chains plan/judge), `src/agents/judge.ts` | router:judge | assembly-gated (#1763: `buildJudgeRoutePrompt` / `buildJudgeEvaluatePrompt` fence user text / QA pair in `<<<UNTRUSTED_USER_TEXT>>>`, systems carry the data rule) |

"Registered" is an inventory claim, not a pass claim. Each registered
row is a filed follow-up, not a silent gap. As of #1763 no prompt
pin remains "registered": the six former follow-ups above are
assembly-gated, pinned by `tests/mlsecops_prompt_gate_1763.test.ts`.

Carried note on the NLQ trusted path: the gate covers the
untrusted assembly (`untrustedContent: true`, the email/webhook/
Slack channel path). Trusted chat/MCP questions deliberately keep
their pre-#862 byte-identical assembly (no delimiters) — delimiting
a trusted user's own question would change the planner's input
without a threat model for it, since that path's content is already
the authenticated user's own instruction, not retrieved/external
data. If the owner wants the trusted path delimited too, that is a
prompt-behavior change to file separately, not a silent gap here.

## Named gaps (not silent)

- **Ad-hoc resolve keys:** `resolveAiModelName()` keys that are not
  config task models (`tradingAgent`) resolve to the key itself when
  unset, so they cannot be pinned to a catalog model id here.
  Reconciling them into config task models (or pinning them
  explicitly) is follow-up work; until then they are outside this
  registry's drift check by design, and this doc says so. (`researchAgent`
  was reconciled into a config task model with a pin by #5109; it is no
  longer an ad-hoc key.)
- **Router chains:** `src/models/router.ts` `MODEL_CHAINS` (plan /
  execute / judge / summarize, cheap → primary → fallback) are fallback
  routing, not the pinned production task models. They are inventoried
  here but not pinned as task models; a chain change is a code change
  reviewed as such, and folding chains into the registry is follow-up
  work if the owner wants one pin surface for both.
- **QA-internal prompts:** `src/qa/investigate.ts` (post-deploy QA
  investigation) is internal tooling, not a production user/trade path,
  and is excluded from this registry deliberately.

## Trial change demonstrated by this PR

This PR itself is the trial change: the registry is created (pin diff),
the gate test runs over the three gated builders on benign + hostile
cases, and the bite-proof tests prove the gate fails on
delimiter-stripped assemblies shaped like the pre-#881 / pre-#882
builders. The degraded assemblies exist only inside the tests;
production code ships only the defended builders.

#CISO-bhdm
