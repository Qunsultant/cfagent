### Fixed

- **Dynamic broker menu live status & account masking (#3430):**
  - Enhanced `ETradeDynamicMenu.tsx` so top-bar buttons, headers, status badges, and action triggers adapt dynamically to the active broker.
  - Enforced broker-specific test environment nomenclature: Alpaca displays `🧪 Paper`, while E*TRADE displays `🧪 Sandbox`.
  - Isolated E*TRADE OAuth credentials and session descriptions from Alpaca; Alpaca status reflects its own neutral API key verification (`GET /api/broker/connect/alpaca`) instead of borrowing E*TRADE OAuth state.
  - Contextual Alpaca key management button toggles `🦙 Manage keys` vs `🦙 Connect Alpaca`.
  - Eliminated hardcoded E*TRADE test account numbers (`••••4748`) on Alpaca surfaces when account details are unread, displaying `"Unavailable"`.
