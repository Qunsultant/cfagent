### Workflow engine

- **Control plane extended to vocabulary stages (#3945)**: the seven uniform stage operations (run / re-run / stop / resume / cancel / schedule / re-schedule) now address vocabulary stages by (runId, stageId) — a node's kind names its catalog stage (feed, enrich, analyze, generate, store, serve, deliver), resolved to its node path in the engine, refusing by name when a stage is absent or two nodes claim it — while the existing (jobId, nodePath) addressing keeps working unchanged. Qunsultant/cfagent#3945
