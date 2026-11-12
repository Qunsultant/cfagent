### Strategy stage vocabulary + per-stage control (#4272)

The strategy screen's stages are now addressable by (runId, stageId) on the control plane under a named strategy vocabulary (the same 8 stages as the options vocabulary, by design), and the `options_copilot_stage_control` surface drives a strategy run's stages with the same per-stage operations and gates as an options run.
