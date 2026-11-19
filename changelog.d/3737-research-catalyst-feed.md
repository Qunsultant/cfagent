### Fixed
- **Research catalyst feed wiring (#3737):** Wired `EtradeResearchDataProvider.getCatalysts` to `getSymbolEventCalendar` (`src/services/eventCalendar.ts`), emitting dated `CatalystInfo` entries for upcoming earnings and ex-dividend events when covered (`[]` when covered with no upcoming events) and returning `null` when uncovered per spec §7.
