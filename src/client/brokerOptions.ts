/**
 * Issue #3855: the settings broker list, derived from the catalog.
 *
 * Why this module exists: the settings page used to carry its own
 * hard-coded two-entry list, so adding a broker meant editing the
 * settings UI — the exact drift the catalog was built to end. The
 * list now comes from the catalog itself: every registered broker
 * appears with its label, its credential kind, and its presentation
 * icon. Registering a broker is a catalog entry (+ its presentation);
 * the settings page picks it up with no settings-UI edit, and
 * unregistering one removes it the same way.
 *
 * The catalog and the presentation lookup are parameters (defaulting
 * to the real ones) so a test can pass a double with an extra broker
 * or a missing one and assert the propagation without touching the
 * production catalog. Nothing here names a broker: the derivation is
 * generic over whatever the catalog holds.
 */
import {
  BROKER_CATALOG,
  brokerPresentation,
  type BrokerAssetAccountRegistry,
  type BrokerCredentialKind,
  type BrokerOperation,
  type BrokerPresentation,
} from "../trading";

/** The fields of a catalog entry this list reads. */
export interface BrokerOptionSource {
  readonly id: string;
  readonly label: string;
  readonly credentialKind: BrokerCredentialKind;
  readonly icon?: string;
  readonly enabled?: boolean;
  /**
   * Issue #6147 (S1): the operations this broker supports. Selectability
   * as the active trading broker reads `orderPlace` from here; absent
   * means unknown, which selects the same as the catalog's own entries
   * (all four carry `orderPlace: true`).
   */
  readonly supports?: Readonly<Partial<Record<BrokerOperation, boolean>>>;
}

/** One broker in the settings list. */
export interface BrokerOption {
  readonly id: string;
  readonly label: string;
  readonly credentialKind: BrokerCredentialKind;
  readonly icon: string;
  /**
   * Issue #6147 (S1): false when the broker cannot be the active trading
   * broker — it has no execution adapter (`orderPlace` capability). The
   * picker renders it disabled with `unavailableReason`; selection of it
   * is refused by name, never silently.
   */
  readonly selectable: boolean;
  readonly unavailableReason?: string;
}

type PresentationFor = (id: string) => Pick<BrokerPresentation, "icon">;

/**
 * Issue #6147 (S1): a broker is selectable as the active trading broker
 * only when its capabilities include order placement. A hosted, read-only
 * broker (a hosted MCP broker with a read-only scope — no execution
 * adapter) renders visible-but-unavailable with the reason: never
 * silently absent, never silently selectable.
 */
function selectability(
  label: string,
  capabilities: Readonly<Partial<Record<BrokerOperation, boolean>>>,
): Pick<BrokerOption, "selectable" | "unavailableReason"> {
  if (capabilities.orderPlace === true) return { selectable: true };
  return {
    selectable: false,
    unavailableReason: `${label} has no execution adapter yet — read-only`,
  };
}

/**
 * The settings broker list, derived from the catalog in catalog order.
 * A broker added to the catalog appears; one removed from it disappears.
 */
export function brokerOptions(
  catalog: Readonly<Record<string, BrokerOptionSource>> = BROKER_CATALOG,
  present: PresentationFor = brokerPresentation,
): BrokerOption[] {
  return Object.values(catalog)
    .filter((entry) => entry.enabled !== false)
    .map((entry) => ({
      id: entry.id,
      label: entry.label,
      credentialKind: entry.credentialKind,
      icon: entry.icon ?? present(entry.id).icon,
      ...selectability(entry.label, entry.supports ?? {}),
    }));
}

/**
 * Issue #5097 (Slice F0): derives the selectable broker options from the
 * runtime-configurable `BrokerAssetAccountRegistry` (#3855 extension).
 */
export function brokerOptionsFromRegistry(
  registry: BrokerAssetAccountRegistry,
  present: PresentationFor = brokerPresentation,
): BrokerOption[] {
  return registry.brokers
    .filter((entry) => entry.enabled)
    .map((entry) => ({
      id: entry.id,
      label: entry.label,
      credentialKind: entry.credentialKind,
      icon: entry.icon || present(entry.id).icon,
      ...selectability(entry.label, entry.capabilities),
    }));
}
