### Fixed
- **Stock Copilot uniform chat UX & Alpaca Paper default guarantee** (#3557):
  - Unified Stock Copilot with Options Copilot and General Copilot by setting `mode: "chat"` in `copilotRegistry.ts`, eliminating the side-by-side dashboard split and providing a full-width conversation stream with sticky bottom composer.
  - Ensured Stock Copilot strictly defaults to Alpaca in Paper mode, preventing account-wide live environment pins from overriding the paper execution base or triggering mode guard refusals.
