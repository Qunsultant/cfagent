### Fixed

- **Dynamic menu harmonization, header deduplication, single mode toggle, and broker isolation (#3719):**
  - **Header Layout & Deduplication**: Unified the dynamic menu header with user profile details in the top-left (@user, login provider) and broker connection details in the top-right (broker title, connection indicator, and mode badge). Removed duplicate broker names and offline labels between headers and status badges.
  - **Broker Dynamic Menu Neutrality**: Introduced broker-neutral `BrokerDynamicMenu.tsx` component, deprecating `ETradeDynamicMenu.tsx` in place with successor pointer for backwards compatibility.
  - **Single Toggle Button**: Replaced dual environment buttons with a single toggle button switching cleanly between Paper and Live, with default client environment initialized to Paper (`TEST`) for unconstrained safe paper trading.
  - **Alpaca & E*TRADE Sync Isolation**: Added broker ID parameter to `runDiagnostics`, ensuring Alpaca diagnostics ping Alpaca endpoints and render API Key / Secret credentials with an Alpaca connection action rather than hardcoded E*TRADE OAuth modal copy. Unconfigured credentials display a yellow status pill rather than an upstream gateway error.
  - **Menu Extraction**: Completely removed redundant Account Details card (`Account Value`, `Account #`, mask toggle) and tuning/downloads clusters from the dynamic menu following their extraction to Platform Admin.

