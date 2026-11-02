### Added

- **One ScreenExecutionBroker for the REST async-or-sync branch** — the two REST stock-screen routes now decide workflow start vs sync fallback through a single broker function built from the Slice 1 run spec, with no behaviour change (Qunsultant/cfagent#2827, under #2764).
