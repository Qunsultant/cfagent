### Host-side options-step composition (#4452)

- The ScheduledAgent host-side step registry now carries the options steps: `optionsStepDepsForScheduledAgent` builds the resolving registration's deps over the host's own storage (definition + artifact stores, chain source, stage-message queue), so a host-dispatched options job executes all eight stages in the host residency.
- No scan-run store is bound on the host, by the #4453 decided-not-to: the persist stage's named degradation is the contract.
