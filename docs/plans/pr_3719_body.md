## Agent
#clo-arsi

Fixes #3719

## Summary
Harmonizes the dynamic menu into a broker-agnostic component (`BrokerDynamicMenu`), removes duplicate broker names and offline badges from headers, isolates broker sync diagnostics, replaces dual environment buttons with a single Paper/Live toggle defaulting to Paper (`TEST`), and cleans up extracted admin controls.

## Problem Description
1. **Dynamic Menu Broker Brand Duplication & Clutter**:
   - The menu displayed repetitive labels (e.g. "E*TRADE Brokerage API", "Offline / Not Connected", and "E*TRADE · OFFLINE" twice).
   - "Account Value", "Account #" (masked), and "Tuning & Options Data / Engine Tuning" occupied valuable dropdown space despite being extracted to Platform Admin.
   - The component was branded `ETradeDynamicMenu` despite the platform moving towards multi-broker neutrality.
2. **Dual-Button Environment Switching**:
   - Environment selection was split into two buttons ("🧪 Paper", "🔴 Live") rather than an intuitive single toggle button, and defaulted to Live rather than safe paper trading.
3. **Cross-Broker Sync Confusion**:
   - Clicking "Sync" on E*TRADE displayed Alpaca diagnostics, or Alpaca displayed E*TRADE OAuth prompts and hardcoded "Connect to E*TRADE" buttons with false upstream gateway errors when unconfigured.
4. **Header Layout Alignment**:
   - User identity was not cleanly grouped on the top-left with broker connection status anchored on the top-right.

## Solution & Key Changes
1. **Unified BrokerDynamicMenu (`src/client/BrokerDynamicMenu.tsx`)**:
   - Deprecated `src/client/ETradeDynamicMenu.tsx` in place naming `src/client/BrokerDynamicMenu.tsx` as successor (#3719).
   - Top-left header displays user card (`@OpenAIMP`, login provider).
   - Top-right header displays broker status (`${selectedBrokerLabel} Brokerage API`, connection dot, mode badge `OFFLINE` / `PAPER` / `LIVE`) without duplicating broker name or offline status.
   - Removed Account Details card and Tuning & Options Data section.
2. **Single Mode Toggle & Safe Paper Default**:
   - Replaced dual buttons with a single toggle button `<Button className="btn-env-mini active ...">` that toggles between `🧪 Paper` and `🔴 Live`.
   - Default environment in `brokerEnvironment.ts` set to `"TEST"` (Paper) for safe unconstrained testing.
   - Added instant local optimistic feedback on toggle click before dispatching network request.
3. **Broker Diagnostics Isolation (`src/client/ETradeTradingHub.tsx`)**:
   - `runDiagnostics(brokerIdOverride, override)` accepts the target broker ID and tests only that broker's gateway and credentials.
   - Alpaca diagnostics display `🦙 Alpaca Diagnostics`, API Key ID / API Secret Key credential statuses, and a yellow `🟡 Unconfigured / Sign-in Required` pill rather than a red gateway error when keys are missing.
   - Connect action for Alpaca opens the Alpaca API keys modal rather than E*TRADE OAuth.

## Verification
- Added `tests/broker_dynamic_menu_neutrality_3719.test.tsx` (4 tests passing).
- Verified `tests/dynamic_menu_broker_neutral_3419.test.tsx`, `tests/broker_login_mode_byok_3668.test.ts`, `tests/broker_menu_mode_3419.test.tsx`, `tests/broker_parity_and_around_the_clock_3694.test.tsx`, `tests/platform_admin_panel_2624.test.tsx`, `tests/ux_panel_tools_fit_2817.test.ts`, and `tests/ux_multi_broker_dynamic_menu_2720.test.tsx` (57 tests passing green).
- Policy Gate verified via `python scripts/ci/policy_gate.py --base origin/main --diff-only`.

## Process documentation impact
Process documentation impact: None - no changes to governance or operational policies required.
