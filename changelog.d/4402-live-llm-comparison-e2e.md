### Live-LLM comparison end-to-end: real core through the engine path (#4402)

- A new suite (`tests/comparison_live_llm_e2e_4402.test.ts`) executes the
  real comparison core (`runProductionComparison`, no module mock, no
  injected LLM fns) through `runComparisonViaEngine` with a stubbed LLM
  gateway (a fake Workers AI binding, the `gateway_executors` idiom):
  the durable pipeline record, the run id shared by the engine job and
  the artifact, and the verbatim three-arm result are asserted, plus
  the verbatim gateway-failure behavior (the engine's unit retry
  re-executes the thunk, so a gateway failure costs two generation
  calls before the run settles failed) and the empty-snapshot skip of
  both gateway calls. No production code changed; no network is
  reachable from the suite (fetch is stubbed to throw).
