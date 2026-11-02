### [#2661] Admin provisioning: email-bearing grants + welcome trigger + grant idempotency

- The IAAA membership grant route accepts an optional grantee email, captured on the membership record; a successful grant with an email best-effort sends the tier-selected welcome (never blocking the grant), unblocking the slice 2.4 welcome trigger.
- Re-granting bindings the target already holds live is a no-op (200, `alreadyProvisioned`), with no new record, no new audit rows, and no second welcome; authorization is still enforced via a read-only canGrantRole pre-check.
- The IAAA admin panel grant form gains an optional grantee email field and reports the welcome outcome.
