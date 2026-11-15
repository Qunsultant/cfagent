### Fixed
- Enforce delivery-time channel recipient verification (`recipient ∈ tenant + run`) at every channel layer (`executor.deliver`, `executor.notify`, `followup_port.deliver`, `followup_port.notify`, `discovery_direct`, `screening_content`, `gated_slack`, `publisher`) with `delivery.recipient_refused` auditing and tenant-scoped delivery claims (`scopedDeliveryClaimRunId`) (#4608).
