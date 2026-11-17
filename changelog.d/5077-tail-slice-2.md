### Changed

- Tail slice 2 (#5077, sub of #3695): OptionsFlowsHub, AsyncJobsPanel, IaaaAdminPanel, and SchedulesPanel are now primitives-only interiors (0 bespoke classes, each rendering at least one PageSection). The four register entries are removed; the interiors total falls 175 → 64.
- NOTE: neither `optionsFlows.css` nor `iaaaAdminPanel.css` retires in this slice — each sheet also styles child components that are not migrated here (FlowFiltersSidebar, FlowSummaryDualBars, FlowTradeDetailModal, news sentiment badges; ServiceUserSection, AdminQueueWipePanel, PolicyProposalsPanel). Both sheets stay fully intact and their imports stay (the hub/panel import is now the subtree's only load of each sheet). Retiring them waits on migrating those children.
