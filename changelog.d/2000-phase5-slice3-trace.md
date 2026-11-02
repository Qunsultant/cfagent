### Observability

- **Trace threading through workflow steps + trace read route (issue #2000, Phase 5 slice 3):** the screener parent flow's fan-out steps now emit workflow-step hops under the run's traceparent (they were the one parent step that never emitted), the shard command's traceparent propagation is pinned at the fan-out seam, and `GET /api/traces?traceId=` surfaces the assembled trace (ordered hops + named breaks + jobIds) behind the existing auth + tenant rules — production proof on a real staged run remains pending the owner run.
