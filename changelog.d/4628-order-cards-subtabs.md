### Fixed

- Order sub-tabs show no ticket card (S3 of #4625, issue #4628): the
  ticket WorkCard, the quote ContextStrip and the "Pending approvals"
  queueRail render on the stock and options tabs only — the approvals
  and NLQ & Guarantee sub-tabs show their own content (the approvals
  queue, the HITL guarantee and NLQ prompt cards) with the Tabs bar
  and page title unchanged. The ticket panel keeps `retain`, so it
  stays mounted-hidden and in-flight ticket work survives tab
  switches. A seed landing while approvals or NLQ & Guarantee is open
  no longer yanks the tab to an asset tab (the post-mount follow
  effect guards all three non-asset tabs, as the mount effect already
  did). The risk tab loses the rail too — it is asset-tabs-only now.
