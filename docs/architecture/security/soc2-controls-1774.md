# SOC 2 formalization — control mapping (#1774, parent #1717, F-55)

Formalizes the SOC 2-relevant controls that exist on current main
into one mapping. This is FORMALIZATION, not attestation: nothing
here claims a SOC 2 Type II audit, a certification, or an auditor
opinion. A control marked Implemented means the mechanism exists in
code or policy on main and is cited; a control marked Partial means
the mechanism exists with a named gap; a control marked Gap means
no mechanism exists yet.

## Access logs (CC7.2 — system monitoring)

| Control | Implementation (evidence) | Status |
|---|---|---|
| Audit events recorded for consequential actions | `mas_events` audit store; `src/agents/routes/audit.ts`; IAAA audit events in `src/security/iaaaAudit.ts` (actor, initiating principal, tenant, action, decision, outcome) | Implemented |
| Tamper detection on the audit trail | SHA-256 hash chain in `src/security/iaaaAudit.ts` (`verifyChain` recomputes every hash and link) | Implemented |
| Audit access itself is logged | `createAuditAccessEvent` / `recordAuditAccess` for `audit:read` / `audit:export` in `src/security/iaaaAudit.ts` | Implemented |
| Audit retention policy | Retention is explicitly UNSETTLED in the IAAA spec §8 (see `iaaaAudit.ts` header) | Gap — carried, owner decision (CISO + CDO) |
| Tamper response (alerting, quarantine, recovery) | Detection exists; response is a later wiring decision (see `iaaaAudit.ts` header) | Gap — carried |

## Zero-trust policies (CC6.1, CC6.6 — logical access, encryption)

| Control | Implementation (evidence) | Status |
|---|---|---|
| Zero-trust posture defined | `docs/architecture/security/zero-trust.md` (§1–§4 mechanisms, §5 honest gaps) | Implemented |
| Default-deny authorization | PDP in `docs/architecture/security/authz.md`; no rule, no access | Implemented |
| Identity verification, no fallback on unknown providers | `docs/architecture/security/authn.md` (unknown provider ids are 403s, never fallbacks) | Implemented |
| Session re-validation on fresh reads + idle expiry | `zero-trust.md` §1 (never the cached copy) | Implemented |
| Revocation never gated | `authz.md` §7 (revocation is a safety action, not subject to the caller's policy) | Implemented |
| Legacy sessions PDP-exempt within a bound | `zero-trust.md` §5.1: exemption bounded by absolute lifetime (createdAt + 7 days); past the bound, gated routes deny until re-login | Partial — drains as legacy sessions expire; not a code fix in this slice |
| Transport encryption | Cloudflare edge TLS termination (see `zero-trust.md` §5 context and `wrangler.jsonc` Worker hosting) | Implemented (platform-provided) |

## Change management (CC8.1)

| Control | Implementation (evidence) | Status |
|---|---|---|
| All changes via branch + PR, never direct to main | `docs/agents/gitops.md` + branch protection (required checks, linear history) | Implemented |
| Pre-merge verification | CI gates: Load Active Environment, Gitleaks, Test & Build, Policy Gate, Analyze (ruleset 25543527) | Implemented |
| No-deletion / deprecation discipline | Policy Gate check (i)/(j) — see repo `AGENTS.md` §22 summary | Implemented |

## Vendor risk (CC9.2 — vendor management)

| Control | Implementation (evidence) | Status |
|---|---|---|
| Vendor inventory with data processed, risk, and controls | `docs/architecture/security/vendor-risk-1774.md` (this slice) | Implemented (as a register) |
| Vendor review cadence | Defined in the register: on material change + annual review; prior formal reviews are NOT evidenced — this register is the first formal one | Partial — first review recorded here, not retroactively claimed |

## Explicitly NOT claimed

- No SOC 2 Type I or Type II report exists for this system, and no
  auditor has opined on these controls. Any external claim otherwise
  would be fabrication.
- "SOC 2 Type II only partial (edge controls)" from the scan is
  superseded by this mapping: the edge controls (access logs,
  zero-trust policies, vendor risk docs) are now formalized above;
  attestation itself remains outstanding and is an owner decision
  (engaging an auditor is not a code slice).

#CISO-bhdm
