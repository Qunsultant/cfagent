/**
 * Wiring Phase 1 — provider registry + config parsing.
 *
 * Layers covered here: config parsing and the registry only. No network
 * calls, no live login flow. The wired callback itself is covered in
 * tests/iaaa_wiring_phase1.test.ts at the binding/session layer.
 */
import { describe, expect, it } from "vitest";
import {
  createProviderRegistry,
  enabledProviders,
  getProvider,
  isProviderEnabled,
  isWiringEnabled,
  listProviders,
  resolveLoginProvider,
  type LoginProvider,
} from "../src/security/providers";

function fakeProvider(id: string): LoginProvider {
  return {
    providerId: id,
    protocol: "oidc",
    issuer: `https://${id}.example`,
    startLogin: async () => new Response("login", { status: 302 }),
    handleCallback: async () => new Response("callback"),
  };
}

describe("isWiringEnabled", () => {
  // Phase 3 (#6550): IAAA_WIRING_ENABLED moved to
  // environment.config.json (defaults.iaaa.wiringEnabled, "1"), so an
  // absent env now resolves to the FILE value (ON).
  it("is on by default (no Env fields resolve to the file value)", () => {
    expect(isWiringEnabled({} as never)).toBe(true);
    expect(isWiringEnabled({ IAAA_WIRING_ENABLED: "0" } as never)).toBe(false);
  });

  it("is on for '1' and 'true' (case-insensitive, trimmed)", () => {
    expect(isWiringEnabled({ IAAA_WIRING_ENABLED: "1" } as never)).toBe(true);
    expect(isWiringEnabled({ IAAA_WIRING_ENABLED: "true" } as never)).toBe(true);
    expect(isWiringEnabled({ IAAA_WIRING_ENABLED: " True " } as never)).toBe(true);
  });

  it("is off for anything else, including 'yes' and '0'", () => {
    for (const v of ["0", "false", "yes", "on"]) {
      expect(isWiringEnabled({ IAAA_WIRING_ENABLED: v } as never)).toBe(false);
    }
    // A blank env value resolves to the file value (ON), not to OFF.
    expect(isWiringEnabled({ IAAA_WIRING_ENABLED: "" } as never)).toBe(true);
  });
});

describe("enabledProviders", () => {
  // Phase 3 (#6550): IAAA_ENABLED_PROVIDERS moved to
  // environment.config.json (defaults.iaaa.enabledProviders,
  // "github,google"), so an absent list now resolves to the FILE list.
  it("defaults to the file list when wiring is on and no list is set", () => {
    expect(enabledProviders({ IAAA_WIRING_ENABLED: "1" } as never)).toEqual(["github", "google"]);
    expect(enabledProviders({ IAAA_WIRING_ENABLED: "1", IAAA_ENABLED_PROVIDERS: "" } as never)).toEqual([
      "github",
      "google",
    ]);
  });

  it("parses comma-separated ids, trimming whitespace and dropping duplicates and empties", () => {
    expect(
      enabledProviders({
        IAAA_WIRING_ENABLED: "1",
        IAAA_ENABLED_PROVIDERS: " github , google,,github , auth0 ",
      } as never)
    ).toEqual(["github", "google", "auth0"]);
  });

  it("keeps unknown ids in the list — the registry, not the parser, refuses them", () => {
    expect(
      enabledProviders({
        IAAA_WIRING_ENABLED: "1",
        IAAA_ENABLED_PROVIDERS: "github,not-a-provider",
      } as never)
    ).toEqual(["github", "not-a-provider"]);
  });
});

describe("registry", () => {
  it("ships with github and google registered (google is the worked plugin example)", () => {
    expect(listProviders()).toContain("github");
    expect(listProviders()).toContain("google");
    const github = getProvider("github");
    expect(github).not.toBeNull();
    expect(github!.providerId).toBe("github");
    expect(github!.issuer).toBe("https://github.com");
    const google = getProvider("google");
    expect(google).not.toBeNull();
    expect(google!.providerId).toBe("google");
    expect(google!.issuer).toBe("https://accounts.google.com");
  });

  it("returns null for an unknown provider — never falls back to another provider", () => {
    expect(getProvider("auth0")).toBeNull();
    expect(getProvider("not-a-provider")).toBeNull();
    expect(getProvider("")).toBeNull();
  });

  it("a fresh registry is empty and accepts a registered adapter, and rejects duplicates", () => {
    const registry = createProviderRegistry();
    expect(registry.listProviders()).toEqual([]);
    expect(registry.registerProvider(fakeProvider("acme"))).toBe(true);
    expect(registry.getProvider("acme")?.issuer).toBe("https://acme.example");
    expect(registry.registerProvider(fakeProvider("acme"))).toBe(false);
    expect(registry.listProviders()).toEqual(["acme"]);
  });
});

describe("isProviderEnabled / resolveLoginProvider", () => {
  it("is false for every provider when wiring is off, even if listed", () => {
    // Phase 3 (#6550): wiring must be explicitly OFF — a bare env
    // now resolves to the file value (ON).
    expect(
      isProviderEnabled(
        { IAAA_WIRING_ENABLED: "0", IAAA_ENABLED_PROVIDERS: "github" } as never,
        "github",
      )
    ).toBe(false);
  });

  it("is true for github when wiring is on and github is listed (or defaulted)", () => {
    expect(isProviderEnabled({ IAAA_WIRING_ENABLED: "1" } as never, "github")).toBe(true);
    expect(
      isProviderEnabled(
        { IAAA_WIRING_ENABLED: "true", IAAA_ENABLED_PROVIDERS: "github" } as never,
        "github"
      )
    ).toBe(true);
  });

  it("is false for a provider not in the enabled list, and for an unregistered id", () => {
    expect(
      isProviderEnabled(
        { IAAA_WIRING_ENABLED: "1", IAAA_ENABLED_PROVIDERS: "github" } as never,
        "google"
      )
    ).toBe(false);
    expect(
      isProviderEnabled(
        { IAAA_WIRING_ENABLED: "1", IAAA_ENABLED_PROVIDERS: "auth0" } as never,
        "auth0"
      )
    ).toBe(false);
  });

  it("resolveLoginProvider returns the provider when enabled, and a disabled reason otherwise", () => {
    const on = resolveLoginProvider({ IAAA_WIRING_ENABLED: "1" } as never, "github");
    expect(on.provider).not.toBeNull();
    expect(on.disabledReason).toBeNull();

    const off = resolveLoginProvider({ IAAA_WIRING_ENABLED: "0" } as never, "github");
    expect(off.provider).toBeNull();
    expect(off.disabledReason).toBe("wiring-disabled");

    const notListed = resolveLoginProvider(
      { IAAA_WIRING_ENABLED: "1", IAAA_ENABLED_PROVIDERS: "github" } as never,
      "google"
    );
    expect(notListed.provider).toBeNull();
    expect(notListed.disabledReason).toBe("provider-not-enabled");

    const unknown = resolveLoginProvider(
      { IAAA_WIRING_ENABLED: "1", IAAA_ENABLED_PROVIDERS: "auth0" } as never,
      "auth0"
    );
    expect(unknown.provider).toBeNull();
    expect(unknown.disabledReason).toBe("provider-not-registered");
  });
});
