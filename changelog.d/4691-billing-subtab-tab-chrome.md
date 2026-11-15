### Fixed

- Billing sub-tab deep links render as a tab, not a page (issue
  #4691): `?tab=billing&view=<id>` now renders as a tab from first
  paint through full load — the tab strip is the navigation, the tab
  label is the title, no Billing page header or servicing description
  above the tab content, and no section re-titles itself inside its
  tab. The Billing route host applies "tab" chrome
  (PageChromeContext, #3125); each section owns its title through
  PageShell. No change to the 10 sub-tab ids or URLs, no flow / money /
  catalog / access change.
