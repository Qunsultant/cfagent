/**
 * Issue #5097 (Slice F0 of #5094): Configurable broker / asset-type / account-type
 * registry, extending the #3855 registry-driven broker list (`BROKER_CATALOG`).
 *
 * Allows adding, editing, enabling, or disabling a broker, asset type, or account
 * type at runtime (through UX and API) without code changes or redeploys.
 */
import { ACCOUNT_TYPES } from "./accountBindings";
import {
  BROKER_CATALOG,
  type BrokerCredentialKind,
  type BrokerOperation,
  type TradingType,
} from "../trading/brokerCatalog";
import { brokerPresentation } from "../trading/brokerPresentation";

export interface BrokerRegistryEntry {
  readonly id: string;
  readonly label: string;
  readonly icon: string;
  readonly enabled: boolean;
  readonly credentialKind: BrokerCredentialKind;
  readonly modes: readonly TradingType[];
  readonly assetTypes: readonly string[];
  readonly accountTypesByAsset: Readonly<Record<string, readonly string[]>>;
  readonly capabilities: Readonly<Partial<Record<BrokerOperation, boolean>>>;
  readonly builtIn?: boolean;
}

export interface BrokerAssetAccountRegistry {
  readonly brokers: readonly BrokerRegistryEntry[];
  readonly assetTypes: readonly string[];
  readonly accountTypes: readonly string[];
  readonly updatedAt: string;
  readonly updatedBy: string;
}

export interface BrokerAssetAccountRegistryPatch {
  readonly upsertBroker?: {
    readonly id: string;
    readonly label?: string;
    readonly icon?: string;
    readonly enabled?: boolean;
    readonly credentialKind?: BrokerCredentialKind;
    readonly modes?: readonly TradingType[];
    readonly assetTypes?: readonly string[];
    readonly accountTypesByAsset?: Readonly<Record<string, readonly string[]>>;
    readonly capabilities?: Readonly<Partial<Record<BrokerOperation, boolean>>>;
  };
  readonly removeBrokerId?: string;
  readonly addAssetType?: string;
  readonly removeAssetType?: string;
  readonly addAccountType?: string;
  readonly removeAccountType?: string;
}

export const DEFAULT_ASSET_TYPES = [
  "stock",
  "options",
  "forex",
  "futures",
  "crypto",
  "retirement",
] as const;

const DEFAULT_ACCOUNT_TYPES_BY_ASSET: Readonly<Record<string, readonly string[]>> = {
  stock: ["stock", "margin", "cash", "ira"],
  options: ["options", "margin", "cash", "ira"],
  forex: ["forex", "margin"],
  futures: ["futures", "margin"],
  crypto: ["crypto", "cash"],
  retirement: ["ira", "cash"],
};

function defaultAccountTypesMapForAssets(
  assets: readonly string[],
): Readonly<Record<string, readonly string[]>> {
  const out: Record<string, readonly string[]> = {};
  for (const a of assets) {
    out[a] = DEFAULT_ACCOUNT_TYPES_BY_ASSET[a] ?? [a, "margin", "cash"];
  }
  return out;
}

/**
 * Seeds the default registry from `BROKER_CATALOG` (#3855) plus an optional
 * hosted MCP broker entry and `ACCOUNT_TYPES`.
 */
export function buildDefaultRegistryWithHosted(hosted?: {
  readonly serverId: string;
  readonly label: string;
  readonly icon: string;
}): BrokerAssetAccountRegistry {
  const catalogEntries: BrokerRegistryEntry[] = Object.values(BROKER_CATALOG).map((def) => {
    const pres = brokerPresentation(def.id);
    const modes: TradingType[] = def.paperMode ? ["paper", "live"] : ["live"];
    const assetTypes = def.assetClasses.map((c) => (c === "equity" ? "stock" : c));
    return {
      id: def.id,
      label: def.label,
      icon: pres.icon || "🏦",
      enabled: true,
      credentialKind: def.credentialKind,
      modes,
      assetTypes,
      accountTypesByAsset: defaultAccountTypesMapForAssets(assetTypes),
      capabilities: { ...def.supports },
      builtIn: true,
    };
  });

  const hostedEntries: BrokerRegistryEntry[] = hosted
    ? [
        {
          id: hosted.serverId,
          label: hosted.label,
          icon: hosted.icon,
          enabled: true,
          credentialKind: "oauth2_refresh_token",
          modes: ["live"],
          assetTypes: ["stock", "options", "forex"],
          accountTypesByAsset: defaultAccountTypesMapForAssets(["stock", "options", "forex"]),
          capabilities: {
            quote: true,
            accounts: true,
            positions: true,
            orderHistory: true,
            accountActivity: true,
          },
          builtIn: true,
        },
      ]
    : [];

  return {
    brokers: [...catalogEntries, ...hostedEntries],
    assetTypes: [...DEFAULT_ASSET_TYPES],
    accountTypes: [...ACCOUNT_TYPES],
    updatedAt: "2026-11-20T00:00:00.000Z",
    updatedBy: "system",
  };
}

function normToken(raw: unknown): string {
  return typeof raw === "string" ? raw.trim().toLowerCase().replace(/[^a-z0-9_-]/g, "") : "";
}

export function applyBrokerRegistryPatch(
  current: BrokerAssetAccountRegistry,
  patch: BrokerAssetAccountRegistryPatch,
  updatedBy = "user",
): { readonly ok: true; readonly registry: BrokerAssetAccountRegistry } | { readonly ok: false; readonly error: string } {
  let brokers = [...current.brokers];
  let assetTypes = [...current.assetTypes];
  let accountTypes = [...current.accountTypes];

  if (patch.addAssetType !== undefined) {
    const token = normToken(patch.addAssetType);
    if (!token) return { ok: false, error: "Asset type identifier cannot be empty." };
    if (!assetTypes.includes(token)) assetTypes.push(token);
    if (!accountTypes.includes(token)) accountTypes.push(token);
  }

  if (patch.removeAssetType !== undefined) {
    const token = normToken(patch.removeAssetType);
    assetTypes = assetTypes.filter((t) => t !== token);
  }

  if (patch.addAccountType !== undefined) {
    const token = normToken(patch.addAccountType);
    if (!token) return { ok: false, error: "Account type identifier cannot be empty." };
    if (!accountTypes.includes(token)) accountTypes.push(token);
  }

  if (patch.removeAccountType !== undefined) {
    const token = normToken(patch.removeAccountType);
    accountTypes = accountTypes.filter((t) => t !== token);
  }

  if (patch.removeBrokerId !== undefined) {
    const id = normToken(patch.removeBrokerId);
    brokers = brokers.filter((b) => b.id !== id);
  }

  if (patch.upsertBroker !== undefined) {
    const raw = patch.upsertBroker;
    const id = normToken(raw.id);
    if (!id) return { ok: false, error: "Broker id is required." };
    const existing = brokers.find((b) => b.id === id);
    const label = (typeof raw.label === "string" && raw.label.trim()) || existing?.label || id.toUpperCase();
    const icon = (typeof raw.icon === "string" && raw.icon.trim()) || existing?.icon || "🏦";
    const enabled = typeof raw.enabled === "boolean" ? raw.enabled : (existing?.enabled ?? true);
    const credentialKind: BrokerCredentialKind =
      raw.credentialKind ?? existing?.credentialKind ?? "api_key_pair";
    const modes: readonly TradingType[] =
      Array.isArray(raw.modes) && raw.modes.length > 0
        ? (raw.modes.filter((m): m is TradingType => m === "paper" || m === "live") as TradingType[])
        : (existing?.modes ?? ["paper", "live"]);
    if (modes.length === 0) {
      return { ok: false, error: "Broker must support at least one trading mode (paper or live)." };
    }
    const entryAssets: readonly string[] =
      Array.isArray(raw.assetTypes) && raw.assetTypes.length > 0
        ? raw.assetTypes.map(normToken).filter(Boolean)
        : (existing?.assetTypes ?? ["stock", "options"]);
    for (const a of entryAssets) {
      if (!assetTypes.includes(a)) assetTypes.push(a);
    }
    const accountTypesByAsset: Record<string, readonly string[]> = {
      ...(existing?.accountTypesByAsset ?? defaultAccountTypesMapForAssets(entryAssets)),
      ...(raw.accountTypesByAsset ?? {}),
    };
    for (const list of Object.values(accountTypesByAsset)) {
      for (const acctType of list) {
        const clean = normToken(acctType);
        if (clean && !accountTypes.includes(clean)) accountTypes.push(clean);
      }
    }
    const nextEntry: BrokerRegistryEntry = {
      id,
      label,
      icon,
      enabled,
      credentialKind,
      modes,
      assetTypes: entryAssets,
      accountTypesByAsset,
      capabilities: {
        ...(existing?.capabilities ?? {}),
        ...(raw.capabilities ?? {}),
      },
      builtIn: existing?.builtIn ?? false,
    };
    const idx = brokers.findIndex((b) => b.id === id);
    if (idx >= 0) {
      brokers[idx] = nextEntry;
    } else {
      brokers.push(nextEntry);
    }
  }

  return {
    ok: true,
    registry: {
      brokers,
      assetTypes,
      accountTypes,
      updatedAt: new Date().toISOString(),
      updatedBy: updatedBy.trim() || "user",
    },
  };
}
