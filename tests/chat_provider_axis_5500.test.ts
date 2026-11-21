/**
 * Issue #5500 — the data-provider axis from a chat turn.
 *
 * The tool that already administers tenant settings (`manage_tenants`,
 * #4741) accepted `dataProviderId` as a free string: a chat turn could
 * write a provider the engine would later refuse, and the model had no
 * way to know the known values. The axis now resolves through the
 * whole-set vocabulary (#5515), so an alias resolves to its canonical
 * id, an unknown value refuses by name with the vocabulary's own code,
 * and the tool's schema lists what may be chosen.
 *
 * The pin drives `buildIntent` (the pure intent builder the command
 * calls before any route) plus the command's published schema, so it
 * proves the refusal without standing up the tenant store.
 */
import { describe, expect, it } from "vitest";
import { buildIntent } from "../src/mcps/openaimp/bizCopilotTenantCommands";
import { ManageTenantsCommand } from "../src/mcps/openaimp/bizCopilotTenantCommands";

describe("#5500 chat selects the data-provider axis", () => {
  it("P01 the schema names the provider and broker values a chat turn may choose", () => {
    const schema = new ManageTenantsCommand().jsonSchema as {
      properties: Record<string, { description?: string }>;
    };
    const provider = schema.properties.dataProviderId?.description ?? "";
    const broker = schema.properties.brokerId?.description ?? "";
    for (const id of ["etrade", "yahoo", "nasdaq", "alpaca"]) {
      expect(provider, `provider description names ${id}`).toContain(id);
    }
    for (const id of ["tastytrade"]) {
      expect(broker, `broker description names ${id}`).toContain(id);
    }
  });

  it("P02 a canonical provider id reaches the patch unchanged", () => {
    const intent = buildIntent({ action: "settings-update", tenantId: "acme", dataProviderId: "yahoo" });
    expect(intent).toMatchObject({
      action: "settings-update",
      patch: { dataProviderId: "yahoo" },
    });
  });

  it("P03 a differently-cased value resolves to the canonical id, not a copy", () => {
    const intent = buildIntent({ action: "settings-update", tenantId: "acme", dataProviderId: "Yahoo" });
    expect(intent).toMatchObject({ patch: { dataProviderId: "yahoo" } });
  });

  it("P04 an unknown provider refuses by name, listing the known values", () => {
    expect(() =>
      buildIntent({ action: "settings-update", tenantId: "acme", dataProviderId: "bloomberg" }),
    ).toThrow(/REFUSAL_VOCABULARY_UNKNOWN_VALUE[\s\S]*bloomberg[\s\S]*yahoo/);
  });

  it("P05 a broker that is not a data provider refuses on the provider axis", () => {
    // tastytrade is a broker (its own axis) and serves no dataset: naming it as
    // the provider is the conflation #5515 removed, so it refuses with the
    // provider values rather than being written and refused later by the engine.
    expect(() =>
      buildIntent({ action: "settings-update", tenantId: "acme", dataProviderId: "tastytrade" }),
    ).toThrow(/REFUSAL_VOCABULARY_UNKNOWN_VALUE[\s\S]*tastytrade[\s\S]*provider/);
  });

  it("P06 an unknown broker refuses the same way, on its own axis", () => {
    expect(() =>
      buildIntent({ action: "settings-update", tenantId: "acme", brokerId: "schwab" }),
    ).toThrow(/REFUSAL_VOCABULARY_UNKNOWN_VALUE[\s\S]*schwab[\s\S]*broker/);
  });

  it("P07 both axes in one update resolve independently", () => {
    const intent = buildIntent({
      action: "settings-update",
      tenantId: "acme",
      dataProviderId: "Nasdaq",
      brokerId: "Alpaca",
    });
    expect(intent).toMatchObject({ patch: { dataProviderId: "nasdaq", brokerId: "alpaca" } });
  });

  it("P08 the existing 'one field required' rule still holds", () => {
    expect(() => buildIntent({ action: "settings-update", tenantId: "acme" })).toThrow(
      /at least one settings field is required/,
    );
  });
});
