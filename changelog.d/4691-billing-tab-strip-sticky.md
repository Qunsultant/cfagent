### Fixed

- Billing tab strip stays visible while scrolling (issue #4691
  follow-up): the Billing sub-tab strip is now sticky (`position:
  sticky`, top 0) within the tab viewport, so it remains the navigation
  while the long section content scrolls. Billing-only (a
  Billing-scoped class on this panel's Tabs); the shared `.ui-tabs`
  default is unchanged, and no other tab's behaviour changes. No change
  to the 10 sub-tab ids or URLs, no flow / money / catalog / access
  change.
