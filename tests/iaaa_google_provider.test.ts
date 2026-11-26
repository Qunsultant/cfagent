/**
 * #945 Google-as-plugin — registry registration for the Google adapter.
 *
 * The Google adapter itself is built by the generic OIDC factory
 * (see tests/iaaa_oidc_provider.test.ts for the factory's behaviour);
 * this file pins the Google registration: issuer, endpoints, env
 * names, scope, subject/login-key fields, and config gating.
 */
import { describe, expect, it } from "vitest";
import {
  getProvider,
  isProviderEnabled,
  listProviders,
  resolveLoginProvider,
} from "../src/security/providers";

describe("google provider registration", () => {
  it("ships registered with the Google issuer, OIDC protocol, and display name", () => {
    expect(listProviders()).toContain("google");
    const google = getProvider("google");
    expect(google).not.toBeNull();
    expect(google!.providerId).toBe("google");
    expect(google!.protocol).toBe("oidc");
    expect(google!.issuer).toBe("https://accounts.google.com");
    expect(google!.displayName).toBe("Google");
  });

  it("is disabled when wiring is off, even if listed", () => {
    // Phase 3 (#6550): IAAA_WIRING_ENABLED lives in
    // environment.config.json (ON in production), so a bare env no
    // longer means wiring is off.
    expect(
      isProviderEnabled({ IAAA_WIRING_ENABLED: "0", IAAA_ENABLED_PROVIDERS: "github,google" } as never, "google")
    ).toBe(false);
    expect(
      resolveLoginProvider({ IAAA_WIRING_ENABLED: "0", IAAA_ENABLED_PROVIDERS: "github,google" } as never, "google")
        .disabledReason
    ).toBe("wiring-disabled");
  });

  it("is not enabled when wiring is on but google is not in the enabled list", () => {
    expect(
      isProviderEnabled(
        { IAAA_WIRING_ENABLED: "1", IAAA_ENABLED_PROVIDERS: "github" } as never,
        "google"
      )
    ).toBe(false);
    expect(
      resolveLoginProvider(
        { IAAA_WIRING_ENABLED: "1", IAAA_ENABLED_PROVIDERS: "github" } as never,
        "google"
      ).disabledReason
    ).toBe("provider-not-enabled");
  });

  it("resolves when wiring is on and google is listed — never falling back to github", () => {
    const resolved = resolveLoginProvider(
      { IAAA_WIRING_ENABLED: "1", IAAA_ENABLED_PROVIDERS: "github,google" } as never,
      "google"
    );
    expect(resolved.disabledReason).toBeNull();
    expect(resolved.provider).not.toBeNull();
    expect(resolved.provider!.providerId).toBe("google");
    expect(resolved.provider!.issuer).toBe("https://accounts.google.com");
  });

  it("an enabled-but-unregistered id is refused as not-registered, never a fallback", () => {
    const resolved = resolveLoginProvider(
      { IAAA_WIRING_ENABLED: "1", IAAA_ENABLED_PROVIDERS: "github,auth0" } as never,
      "auth0"
    );
    expect(resolved.provider).toBeNull();
    expect(resolved.disabledReason).toBe("provider-not-registered");
  });
});
