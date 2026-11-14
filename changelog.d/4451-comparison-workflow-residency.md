### Workflow residency: comparison job (#4451)

- The comparison job (`comparison:<runId>`) now composes into the workflow residency: a resolving `comparison.run` step rebuilds the whole comparison per invocation (snapshot fetch, core agent functions, question) and executes the real comparison core, and a `startComparisonWorkflow` seam starts comparison runs through `workflow.create` with dispatch-time shape validation.
- The host read-back is comparison-aware: a comparison run reports one `comparison` stage and no shape report.
- The snapshot mapping and comparison question are now shared helpers in the comparison runner, used by the panel route, the NLQ runner, and the resolving step alike.
