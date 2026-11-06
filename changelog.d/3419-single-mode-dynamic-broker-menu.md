### Fixed

- **Dynamic broker menu & single active mode (#3419):**
  - Enhanced `ETradeDynamicMenu.tsx` so top-bar buttons, headers, status badges, and action triggers adapt dynamically to the active broker.
  - Enforced single active mode per broker: Alpaca displays `🧪 Paper` vs `🔴 Live`, while E*TRADE displays `🧪 Sandbox` vs `🔴 Live`. At any time only one mode is active.
  - Isolated E*TRADE OAuth credentials and session descriptions from Alpaca; Alpaca status reflects its own neutral API key verification (`GET /api/broker/connect/alpaca`) instead of borrowing E*TRADE OAuth state.
  - Eliminated hardcoded E*TRADE test account numbers (`••••4748`) on Alpaca surfaces.
