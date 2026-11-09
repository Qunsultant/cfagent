/**
 * Issue #3382 — a first order is never live by accident.
 *
 * A tenant who has never chosen anything is on paper for the two places
 * that decide which account an ACTION uses:
 *
 *   - placing an order (preview stamps the mode, execute spends it), and
 *   - signing a broker in (the credential side must match the mode it trades).
 *
 * Choosing live is an explicit act that persists a selection.
 *
 * Issue #3857 (owner rule, superseding the reads half of this file):
 * the default broker mode is paper (TEST), never live — for READS as
 * well as actions. The mode is one selection (`etrade:environment`);
 * the read resolver and the trade resolver now agree that an unset
 * selection means paper. The pin below that used to hold reads on the
 * deployment default is updated to the paper default with the reason
 * recorded here, not silently.
 */
import { describe, it, expect } from "vitest";
import {
  resolveBrokerEnvironmentFromSettings,
  resolveTradeEnvironmentFromSettings,
} from "../src/agents/routes/brokerEnvironment";

const readSetting = (stored: string | null | undefined) => (key: string) =>
  key === "etrade:environment" ? (stored ?? null) : null;

/** A live deployment, as far as resolution is concerned. */
const PROD_ENV = { APP_ENV: "PROD", ETRADE_ENVIRONMENT: "live" } as any;

describe("the trade mode defaults to paper (#3382)", () => {
  it("is TEST when the tenant has never chosen", () => {
    expect(resolveTradeEnvironmentFromSettings(readSetting(null), PROD_ENV)).toBe("TEST");
  });

  it("is TEST when there is no settings reader at all", () => {
    expect(resolveTradeEnvironmentFromSettings(undefined, PROD_ENV)).toBe("TEST");
  });

  it("still honours a stored live choice", () => {
    expect(resolveTradeEnvironmentFromSettings(readSetting("PROD"), PROD_ENV)).toBe("PROD");
  });

  it("honours a stored paper choice", () => {
    expect(resolveTradeEnvironmentFromSettings(readSetting("TEST"), PROD_ENV)).toBe("TEST");
  });

  it("ignores a garbage stored value and stays on paper", () => {
    expect(resolveTradeEnvironmentFromSettings(readSetting("LIVE"), PROD_ENV)).toBe("TEST");
  });
});

describe("reads default to paper too (#3857)", () => {
  it("honours both stored values exactly as before", () => {
    expect(resolveBrokerEnvironmentFromSettings(readSetting("TEST"), PROD_ENV)).toBe("TEST");
    expect(resolveBrokerEnvironmentFromSettings(readSetting("PROD"), PROD_ENV)).toBe("PROD");
  });

  it("falls back to paper for a tenant with no choice", () => {
    // Pinned on purpose (#3857, owner rule): the default mode is paper,
    // for reads as for actions — live is an explicit stored selection.
    // This supersedes #3382's reads-keep-the-deployment-default pin.
    expect(resolveBrokerEnvironmentFromSettings(readSetting(null), PROD_ENV)).toBe("TEST");
  });
});
