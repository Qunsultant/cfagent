/**
 * Externalized configuration for multi-account & asset-class account bindings
 * (issues #5094, #5110).
 */
export const ACCOUNT_TYPES = [
  "stock",
  "options",
  "forex",
  "futures",
  "crypto",
  "ira",
  "margin",
  "cash",
] as const;

export const ACCOUNT_BINDING_SCOPES = [
  "tenant",
  "autopilot",
  "copilot",
  "schedule",
] as const;

export const ACCOUNT_BINDING_CONFIG = {
  namespace: "account_bindings",
  keyPrefix: "acctbind:v1:",
  registryKeyPrefix: "acctreg:v1:",
  defaultAccountType: "stock" as (typeof ACCOUNT_TYPES)[number],
  defaultScope: "tenant" as (typeof ACCOUNT_BINDING_SCOPES)[number],
} as const;
