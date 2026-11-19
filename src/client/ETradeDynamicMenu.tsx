/**
 * @deprecated Superseded by `src/client/BrokerDynamicMenu.tsx` (#3719, #5236).
 * Kept as a deprecated re-export shim per gitops §22 (no deletion without owner
 * decision); all callers import `BrokerDynamicMenu` / `SettingsMenu` directly.
 */
import type {} from "./components/ui";
export * from "./BrokerDynamicMenu";
export { BrokerDynamicMenu as default, BrokerDynamicMenu as SettingsMenu } from "./BrokerDynamicMenu";
