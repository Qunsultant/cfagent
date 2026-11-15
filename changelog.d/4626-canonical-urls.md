### Changed

- One canonical URL per surface (S1 of #4625, issue #4626): the five
  dual-homed addresses retire onto the home where their workflow lives,
  via `legacyDualHomeRedirect` (applied in `Chat.tsx` `applyRoute`
  before the tab is adopted) — `?tab=screeners` onto the Assets Hub,
  `?tab=research` onto `?tab=stock-hub&view=research`,
  `?tab=options-flows` onto `?tab=options&view=options-flows`,
  `?tab=risk-analysis` onto `?tab=order&orderTab=risk`, and
  `?tab=approvals` onto `?tab=order&orderTab=approvals` (reversing
  #4538's standalone home). The retired routes stay in the route table
  as redirects; the Approvals and Options Flows nav entries are removed
  (27 nav entries, display order 0..26) and the Approvals page is
  deprecated in place, unmounted, with the order approvals sub-tab as
  its successor. Inner-view params (`flowsTab`, `researchTab`, `riskTab`)
  narrow to their canonical owner; every in-app `?tab=approvals` link
  re-points to the sub-tab.
