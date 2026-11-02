### Breakers

- **Durable breaker store + trip subscriber + trip alerting (Qunsultant/cfagent#2000, Phase 5 slice 2):** breaker trips now persist to D1 (migration 0034) so a trip in one isolate protects siblings and survives recycle; open transitions post a Slack alert exactly once per transition via a guarded claim.
