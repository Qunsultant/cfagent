### Changed

- Scheduled stock screens no longer fall back to E*TRADE when no stock-screen provider can be resolved: the run is refused with the coded FAILURE_NO_SCREENING_PROVIDER outcome instead of screening another provider's data. A Public data-provider selection now resolves to the Public adapter. The three inline broker fallbacks in the scheduler now resolve through the platform broker resolver, so the file no longer carries its own E*TRADE default.
