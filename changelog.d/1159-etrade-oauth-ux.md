### Fixed
- E*TRADE OAuth failures on the trading hub now surface in a persistent top-level banner (was: message rendered only inside the PIN modal, which opens only on success, so a failed start showed nothing).
- E*TRADE authorization tab now opens synchronously before the OAuth-start fetch, so browsers no longer block it as a popup; if the open itself is blocked, the authorize URL stays reachable from a hub banner after the PIN modal is dismissed.
