### Strategy entry-point routing (#4273)

Strategy screens now pin their entry-point routing: the NLQ panel leg, the
NLQ scan leg (which the `run_options_strategy_screen` mesh door dispatches
to), and the manual panel route each define a `strategy-screen:<runId>`
engine job with a durable pipeline record, never an options job. The
scheduled firer (`runDiscoveryRequest`) remains the one strategy entry
outside the engine job and is owned by #4275.
