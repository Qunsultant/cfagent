/**
 * Issue #3382 — a first order is never live by accident.
 *
 * The deployment's environment (PROD on the live worker) is the right default
 * for READS: a tenant on the live deployment should see the live account. It is
 * the wrong default for the two places that decide which account an ACTION uses:
 *
 *   - placing an order (preview stamps the mode, execute spends it), and
 *   - signing a broker in (the credential side must match the mode it trades).
 *
 * A tenant who has never chosen anything is on paper for both; choosing live is
 * an explicit act that persists a selection. Reads keep the deployment default,
 * so nothing about the live data plane changes.
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

describe("reads keep the deployment default (#3382)", () => {
  it("honours both stored values exactly as before", () => {
    expect(resolveBrokerEnvironmentFromSettings(readSetting("TEST"), PROD_ENV)).toBe("TEST");
    expect(resolveBrokerEnvironmentFromSettings(readSetting("PROD"), PROD_ENV)).toBe("PROD");
  });

  it("still falls back to the deployment for a tenant with no choice", () => {
    // Pinned on purpose: this change must not move what a live deployment reads.
    expect(resolveBrokerEnvironmentFromSettings(readSetting(null), PROD_ENV)).toBe("PROD");
  });
});
