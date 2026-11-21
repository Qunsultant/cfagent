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
  "ux",
  "audit",
] as const;

export const ACCOUNT_BINDING_CONFIG = {
  namespace: "account_bindings",
  keyPrefix: "acctbind:v1:",
  registryKeyPrefix: "acctreg:v1:",
  defaultAccountType: "stock" as (typeof ACCOUNT_TYPES)[number],
  defaultScope: "tenant" as (typeof ACCOUNT_BINDING_SCOPES)[number],
  failureCodes: {
    unknownAccount: "FAILURE_ACCOUNT_UNKNOWN",
    unownedAccount: "FAILURE_ACCOUNT_UNOWNED",
    assetTypeMismatch: "FAILURE_ACCOUNT_ASSET_TYPE_MISMATCH",
    brokerMismatch: "FAILURE_ACCOUNT_BROKER_MISMATCH",
    migrationAmbiguous: "FAILURE_ACCOUNT_MIGRATION_AMBIGUOUS",
    bindingMissing: "FAILURE_ACCOUNT_BINDING_MISSING",
  },
} as const;
