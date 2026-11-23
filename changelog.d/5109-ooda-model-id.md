### Fixed

- OODA/research run trigger no longer fails with `research_agent_turn_incomplete: Invalid model id "researchAgent"` (#5109): `researchAgent` is now a config task model resolving to the flagship `@cf/zai-org/glm-4.7-flash` (same as the sibling `marketResearch` role), with a matching pin in the model/prompt registry. The OODA button and the nightly schedule previously never produced a run because `resolveAiModelName` returned the bare key when the task model was unregistered.
- The `research-agent-think-turn` pin that asserted `getModel()` returned the bare key `"researchAgent"` now asserts the resolved Workers AI id, so the suite pins the valid model instead of the defect.
