### Issue #5113 — UX & API route for { broker, mode, accountType, accountId } selection (Sub-issue 4 of #5094)

- Added `src/agents/routes/accountBindings.ts` (`GET`/`PUT`/`DELETE /broker/account-binding`) and mounted it in `src/agents/orchestrator/routeRequest.ts`.
- Added `src/client/AccountBindingSelector.tsx` built strictly from `src/client/components/ui` primitives (`Card`, `CardHeader`, `Select`, `TextInput`, `Button`, `Badge`, `Notice`, `Stack`, `Flex`).
- Added `tests/account_binding_ux_5113.test.tsx`.
