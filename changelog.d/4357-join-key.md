### One engine

- **One run, one row: wrapper, bridge, and engine records linked** — a chat stock screen's wrapper row, bridge row, and engine D1 run record now carry a shared join key (bridge `parentJobId`, engine `asyncJobId`), so Workflow Runs renders the incident shape as one run under the wrapper id with the workflow instance id surfaced where known; unlinked and pre-slice rows render as today (Qunsultant/cfagent#4357).
- **Engine runs carry their dispatching async job id** — `runJob` accepts `asyncJobId`, persisted on the instance (migration 0065) and stamped on the terminal run record, surviving resume and settle paths (Qunsultant/cfagent#4357).
