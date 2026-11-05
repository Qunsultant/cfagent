### Signup → Trial onboarding flow (#3256)

- First-run setup is now a real five-step flow: account creation, free-trial choice, live E*TRADE connect, notification preferences, and a server-fetched setup summary.
- Server-side onboarding state (migration 0042, `agent_onboarding_state`) keyed by verified login, with resume at the saved step and cross-device completion.
