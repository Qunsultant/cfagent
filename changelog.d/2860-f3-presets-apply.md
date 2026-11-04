### Changed

- **Presets tab Apply applies, audit F3 (#2860, under #2764) #clo-arsi:**
  StockHub wired the presets tab's `onApplyPreset` to a bare tab change,
  dropping the criteria the panel passes up — Apply landed on New Screen
  with whatever draft criteria were there (the same shape as the old
  patterns bug, audit F1, fixed by G2 #2909). The presets tab now applies
  through `handleCriteriaChange` (sets the criteria, clears any applied
  pattern) and then navigates, the same order PresetsPanel already uses
  internally. The new-screen deck already applied this way, and scheduled
  runs already resolve presets at run time (`resolvePresetFilter`), so only
  the presets tab boundary changed. No behavior change to starter presets
  (still read-only proposals, copied to My Presets before use).
