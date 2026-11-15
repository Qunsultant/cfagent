# UX architecture — single source of truth

> One place for UX: this folder. The live contract is
> [`ux-architecture.md`](ux-architecture.md) (§20
> Definition of Done), in this folder since D1 (#4632). This README is
> the entry point: it names the live contract, the status of every file
> in this folder, and the canonical sources elsewhere. It states no
> rule of its own and duplicates no rule text.

## The live contract

- **Live contract:**
  [`ux-architecture.md`](ux-architecture.md) —
  §20 Definition of Done. It governs. (Moved here from
  `docs/agents/` in D1, #4632; pointers migrated in that slice.)
- **No exceptions.** Ceos 2026-11-15 (#4632 Q6): one consistent
  implementation, no documented exceptions. The design-system §3.6
  exception register is **VOID**: the two items it recorded (ScreenersHub
  bespoke tablist; landing-page second theme) are fix work, not
  exceptions. The draft's §3.6 text is superseded; D2 removes it.

## Files in this folder

| File | Status | What it is |
| --- | --- | --- |
| `ux-architecture.md` | **LIVE** | The live contract (§20 Definition of Done). It governs. Moved here from `docs/agents/` in D1 (#4632). |
| `consolidated-design-system.md` | **DRAFT** | One holistic replacement for the scattered UX docs (page template §1, design system §2, theme system under the rule of three §3, source map + contradictions §4, owner decisions §5). Placed 2026-11-04 per #3096. The §5 decisions are still pending; placement is not approval of its contents and it does not replace anything on its own. Adopt §4 (incl. C1–C10) in D2 — do not redo the consolidation. |
| `consistent-ux-standards-and-patterns.md` | **ACTIVE** | Architectural reference and implementation blueprint. Complements the live contract and the consolidated draft. |
| `schedule-surface-01.md` | **LIVE** | Schedules surface pattern. |
| `template-gate-layout-freeze-3136.md` | **LIVE** | Route-to-template gate spec (#3136). |
| `token-mapping-order-options-autopilot.md` | **LIVE** | Token mapping for the order / options / autopilot legacy classes (#3135; 651 rows, pinned by `tests/template_token_tiers_3135.test.ts`). |

## Retired — moved to `docs/archive/`

| File | Moved to | Superseded by |
| --- | --- | --- |
| `design-system-01.md` | `docs/archive/design-system-01.md` | `consolidated-design-system.md` (DRAFT, #3096). Superseded in substance; also carries stale counts (C1, C2, C4) and a self-contradictory header. |
| `assessment-01.md` | `docs/archive/assessment-01.md` | No successor: point-in-time snapshot (2026-10-25). Its findings are partially addressed since, with no doc recording what remains open (C6). It states no live rule; the live gates are the current enforcement. |
| `exceptions-01.md` | `docs/archive/exceptions-01.md` | No successor: point-in-time snapshot (2026-10-25, pre-ADR-0004). The live state is the freeze allowlist (empty) and `docs/architecture/security/ux-primitives-1772-verification.md` (44/44 converted). |

## Canonical sources elsewhere (linked, not copied)

- **ADR — token architecture:**
  [`docs/architecture/adr/0004-ux-token-architecture-no-exemptions.md`](../adr/0004-ux-token-architecture-no-exemptions.md)
  (link by full filename — ADR 0004 exists twice).
- **Code rules:**
  [`docs/architecture/code/06-client-ux-code.md`](../code/06-client-ux-code.md)
  — the justified second home for code rules (gitops §22, #3800).
- **Standards:** [`docs/architecture/standards/standards.md`](../standards/standards.md)
  §9. (Note: §9.1 still repeats the stale C4 claim that the tab-mechanism
  reconciliation is open — fix in place in D2, out of scope for D0.)
- **Accessibility:** `docs/agents/tech-standards.md` §10.
- **Reference pattern:**
  [`docs/architecture/reference/tabbed-browsing.md`](../reference/tabbed-browsing.md)
  (note: C3 — the hub never adopted the `Tabs` primitive; fix work
  under Q6, not an exception).
- **Completed program record:**
  [`docs/plans/UX/ux-token-architecture-plan.md`](../../plans/UX/ux-token-architecture-plan.md)
  + `baseline/` (live machine artifacts, do not move as docs).
- **Verification record:**
  [`docs/architecture/security/ux-primitives-1772-verification.md`](../security/ux-primitives-1772-verification.md)
  (CLOSED evidence: 44/44 exception files converted).
- **Anti-drift framework:**
  [`docs/compliance/anti-drift.md`](../../compliance/anti-drift.md)
  (the consolidation precedent #3802 lives here).
- **Index:** [`docs/architecture/ADD.md`](../ADD.md).
- **Delivery policy:** [`docs/agents/gitops.md`](../../agents/gitops.md)
  (cites UX docs; does not absorb them — the §9 checklist cites
  `ux-architecture.md` §20, migrated with it in D1).

## What is NOT in this folder

- **Agentic UX (#3082)** — separate workstream; not consolidated here.
