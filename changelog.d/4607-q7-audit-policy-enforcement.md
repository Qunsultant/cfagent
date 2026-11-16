### Changed
- `#4607`: Activated Q7 audit policy enforcement by flipping `AUDIT_POLICY_DEFAULT_MODE` from `"audit-only"` to `"enforcing"` in `src/data/auditPolicyPorts.ts` (and failing closed unknown mode strings to `"enforcing"`), per CISO+CDO sign-off.
