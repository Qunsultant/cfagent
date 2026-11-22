### #5885: flip the screener deliver node onto generic deliver.apply

- The screener spec's deliver node now runs generic `deliver.apply` with `screener: true`, and both residencies wire the real deliver door (`buildDeliverDoor`) as the screener sink.
- `runGenerateJob` builds the delivery payload for a screener-report from the report document (`buildScreenerDeliveryPayload`) and carries it plus the canonical report id (`reportId`) on the run result; `generate.apply` passes both through as `payload` + `reportId`, and the door stamps the payload-carried canonical report id onto the market outcome.
- Known limitation (pinned by test): the generic chain carries no `duplicate` signal, so a second delivery of the same generate output re-calls the sink with the same `workflow:<jobId>` delivery id — wasted work, not double delivery.
