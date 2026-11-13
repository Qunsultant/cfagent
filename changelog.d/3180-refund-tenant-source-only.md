### Refund tenant is source-only: no client-supplied fallback

- The refund request path no longer accepts a client-supplied tenantId: the record's tenant comes from the resolved payment source only (the subscription row for subscription refunds, the saga's verified payment context for saga compensation). When the source carries no tenant, the request is refused with a typed `RefundTenantUnresolvableError` before any record is created, instead of trusting request input.
- The POST /refunds request body no longer carries a tenant field; a body that still sends one is ignored. Sourced subscription refunds, the operator approve/execute path, refund amounts, approvals, and the #2549 credit-XOR-refund guard are unchanged.
