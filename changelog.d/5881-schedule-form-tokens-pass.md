### Configure New Schedule: tokens.css/primitives.css usability pass (#5881)

- Moved the create form's 13 inline `style={{` props (CadenceFields,
  DiscoveryFormSections, NotificationFields, ScheduleFormModal,
  ThesisRiskFields) onto the Grid/Disclosure primitives, `sched-*`
  classes, and `ui-mt-*` utilities; the five files' #3047 inline-style
  baselines go to 0.
- Added the `Disclosure` primitive (`ui-disclosure`, native
  details/summary) for the form's custom-criteria section, and the
  `ui-mt-2` / `ui-mt-2-5` / `ui-mt-3` margin utilities.
- Converted the hardcoded pixels in `scheduledOptions.css` to exact
  rem equivalents (no `px` literal survives except 1px borders) and
  removed the two dead rules (`sched-dialog-title`,
  `sched-detail-section-title`) with their freeze entries.
- Sizes are preserved exactly: this is a conformance pass, not a
  visual redesign.
