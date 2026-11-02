### Observability

- **Stage events into the #1743 stream as new type values only (Qunsultant/cfagent#2000, Phase 5 slice 4):** eight new whitelisted types (`screener.stage.<feed|gather|analysis|deliver>_<completed|failed>`) fold to counts+ids events (tenant, run id, optional count); no envelope shape change, no writer change, and the existing whitelist + redaction apply unchanged — prompt text, thesis text, identities, and error messages never survive the fold.
