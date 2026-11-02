/**
 * Issue Qunsultant/cfagent#2053 (under #1717): A2A token naming trap.
 *
 * The outbound cfpay A2A token must be read from the direction-explicit
 * CFPAY_OUTBOUND_TOKEN first, with DASHBOARD_API_KEY_IS_A2A_TOKEN kept
 * only as a deprecated transitional fallback (superseded by
 * CFPAY_OUTBOUND_TOKEN) and CFPAY_A2A_TOKEN as the pre-existing third
 * fallback. The inbound token A2A_API_TOKEN must NEVER enable outbound
 * calls: no aliasing between the directions, and inbound handling is
 * untouched (fail-closed 503 when unset, 401 on a wrong token, at the
 * A2A edge — not here).
 */
import { describe, it, expect } from "vitest";
import { getCfpayConfig } from "../src/services/cfpayA2A";

describe("getCfpayConfig outbound token names (#2053)", () => {
  it("reads the direction-explicit CFPAY_OUTBOUND_TOKEN", () => {
    const config = getCfpayConfig({ CFPAY_OUTBOUND_TOKEN: "outbound-token" });
    expect(config?.token).toBe("outbound-token");
  });

  it("prefers CFPAY_OUTBOUND_TOKEN over the deprecated old name", () => {
    const config = getCfpayConfig({
      CFPAY_OUTBOUND_TOKEN: "new-token",
      DASHBOARD_API_KEY_IS_A2A_TOKEN: "old-token",
    });
    expect(config?.token).toBe("new-token");
  });

  it("still reads DASHBOARD_API_KEY_IS_A2A_TOKEN as a deprecated fallback", () => {
    const config = getCfpayConfig({
      DASHBOARD_API_KEY_IS_A2A_TOKEN: "old-token",
    });
    expect(config?.token).toBe("old-token");
  });

  it("still reads CFPAY_A2A_TOKEN as the pre-existing fallback", () => {
    const config = getCfpayConfig({ CFPAY_A2A_TOKEN: "legacy-token" });
    expect(config?.token).toBe("legacy-token");
  });

  it("returns null when no outbound token name is set", () => {
    expect(getCfpayConfig({})).toBeNull();
  });

  it("does NOT treat the inbound A2A_API_TOKEN as an outbound token", () => {
    expect(getCfpayConfig({ A2A_API_TOKEN: "inbound-token" })).toBeNull();
  });
});
