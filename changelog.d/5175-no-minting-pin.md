### Added

- #5175 slice 4: no-minting-elsewhere pin — a census over every run/job-id mint signature in `src/` (20 tests) that fails on any new id minting outside the one leaf minter; decided exemptions and known-unmigrated mints are recorded exactly so they cannot grow silently.
