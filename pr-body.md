## Agent
#cfo-qunso

## Summary
The Workflow Catalog is now its own page under the Workflows menu (#3116).

- Route `workflow-catalog` added to the externalized nav data: `navGroup: "workflow-runs"`, a `workflow-catalog` item in that sub-menu, and **no top-level `navEntry`** (like `reports`) so the Platform column keeps exactly its seven items.
- `WorkflowCatalogPage` supplies the shell (`PageShell` + `PageSection`) around the existing `WorkflowCatalogPanel` — no new CSS, no inline styles.
- The hub's `catalog` sub-tab is removed, so there is one surface, not two.
- Pins updated in the same change: route count 42 → 43, the Workflows sub-menu list now names `workflow-catalog`; nav shape (contiguous navOrders 0..30), left-nav, deep-link, derivation and panel suites green — 63 tests in the targeted run.

## Linked issue
Closes #3116

## Full report
The full report for this PR lives in the linked issue's completion report (gitops §15). This PR body is a pointer, not a second record.

## Checklist
- [x] Required checks green on the current merge with `main` (CI verifies)
- [x] Pins my change alters are updated in this PR (gitops §7) — nav shape + left-nav sub-menu list
- [x] CHANGELOG fragment added (`changelog.d/3086-workflow-catalog-page.md`)
- [x] Process documentation impact: none
- [ ] Linked issue's completion report updated
