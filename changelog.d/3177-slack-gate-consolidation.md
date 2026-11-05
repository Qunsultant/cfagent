### Fixed

- All direct Slack publishers now route through one gated dispatch (`deliverGatedSlack`), so a tenant's Slack disable is enforced everywhere instead of only on the delivery funnels; system auth alerts keep their exact text and dedupe but now send via the master sender (A2A first, direct fallback) instead of depending on cfpay being configured (#3177).
