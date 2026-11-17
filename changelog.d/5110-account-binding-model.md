### Issue #5110 — Account binding domain model & persistence seam (Sub-issue 1 of #5094)

- Added `src/config/accountBindings.ts` externalizing supported `ACCOUNT_TYPES` (`stock`, `options`, `forex`, `futures`, `crypto`, `ira`, `margin`, `cash`), `ACCOUNT_BINDING_SCOPES` (`tenant`, `autopilot`, `copilot`, `schedule`), and storage defaults.
- Added `src/trading/accountBindings.ts` (exported through `src/trading/index.ts`) with validation (`validateAccountBindingInput`) and strict same-`(broker, mode, accountType)` scoped resolution (`resolveEffectiveAccountBinding`).
- Added `src/services/accountBindings.ts` persisting per-user `{ broker, mode, accountType, accountId }` bindings in `SessionStore` DO (`account_bindings` namespace).
- Added `tests/account_bindings_5110.test.ts`.
