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
  type BrokerCredentialKind,
  type BrokerPresentation,
} from "../trading";

/** The fields of a catalog entry this list reads. */
export interface BrokerOptionSource {
  readonly id: string;
  readonly label: string;
  readonly credentialKind: BrokerCredentialKind;
}

/** One broker in the settings list. */
export interface BrokerOption {
  readonly id: string;
  readonly label: string;
  readonly credentialKind: BrokerCredentialKind;
  readonly icon: string;
}

type PresentationFor = (id: string) => Pick<BrokerPresentation, "icon">;

/**
 * The settings broker list, derived from the catalog in catalog order.
 * A broker added to the catalog appears; one removed from it disappears.
 */
export function brokerOptions(
  catalog: Readonly<Record<string, BrokerOptionSource>> = BROKER_CATALOG,
  present: PresentationFor = brokerPresentation,
): BrokerOption[] {
  return Object.values(catalog).map((entry) => ({
    id: entry.id,
    label: entry.label,
    credentialKind: entry.credentialKind,
    icon: present(entry.id).icon,
  }));
}
