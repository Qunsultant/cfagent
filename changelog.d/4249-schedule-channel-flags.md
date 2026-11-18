### Scheduling

- Flag-gate both agentic-scheduling channels (Qunsultant/cfagent#4249): new `schedule_chat` flag (default ON — chat is the default channel, listed first) and `schedule_nlq` flag (default OFF — NLQ is secondary). The chat entry point (schedule.* A2A ops) and the NLQ entry point (NLQ schedule intents) refuse with coded `FEATURE_DISABLED` when their channel is off; both channels off is refused with `SCHEDULE_CHANNELS_BOTH_OFF` (one-on invariant). Flags are registered in `ALL_FEATURE_FLAGS` and evaluated through the existing `FeatureFlagPort`; no second flag mechanism.
