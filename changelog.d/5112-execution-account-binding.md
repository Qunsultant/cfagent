### Issue #5112 — Thread { broker, mode, accountType, accountId } through execution & audit (Sub-issue 3 of #5094)

- Added `resolveExecutionAccountContext` and `accountBindingAuditFields` in `src/services/accountBindings.ts`.
- Threaded account-binding resolution and audit logging (`broker.account_binding_resolved`, `schedule.account_binding_resolved`) into `src/agents/routes/brokerOrders.ts` and `src/agents/routes/schedules.ts`.
- Added `tests/account_binding_execution_5112.test.ts`.
