import { describe, expect, it } from "vitest";
import { jobDefinitionSpec, resolveJobDefinitionSpec } from "../src/config/jobDefinitionCatalog";
import { bindJobDefinitionParams } from "../src/services/jobDefinitionParamBinders";

describe("5496 generic declarative parameter binder", () => {
  it("binds screener declaratively with enumSource + derivation + default", () => {
    const bound = bindJobDefinitionParams(
      jobDefinitionSpec("screener"),
      { universe: "NASDAQ100" },
      "owner",
    );
    expect(bound.userLogin).toBe("owner");
    expect(bound.trigger).toBe("scheduled");
    expect(bound.universe).toBe("NASDAQ100");
    expect(bound.deliver).toBe(false);
    expect(Array.isArray(bound.shards)).toBe(true);
    expect((bound.shards as Array<{ universe?: string }>)[0]?.universe).toBe("NASDAQ100");
  });

  it("binds a new spec family purely from declarations with zero binder code", () => {
    const customSpec = resolveJobDefinitionSpec({
      id: "custom-feed-test",
      name: "Custom feed test",
      version: 1,
      stages: [{ kind: "feed", step: "custom.feed" }],
      parameters: [
        {
          name: "source",
          label: "Source",
          type: "select",
          required: true,
          options: ["alpaca", "moomoo"],
        },
        {
          name: "maxItems",
          label: "Max items",
          type: "number",
          default: { setting: "custom.maxItems" },
        },
      ],
    });
    const bound = bindJobDefinitionParams(
      customSpec,
      { source: "alpaca" },
      "owner",
      (key) => (key === "custom.maxItems" ? 25 : undefined),
    );
    expect(bound).toEqual({
      userLogin: "owner",
      trigger: "scheduled",
      source: "alpaca",
      maxItems: 25,
    });
  });

  it("refuses unknown derivation or enumSource by name at load/validation time", () => {
    expect(() =>
      resolveJobDefinitionSpec({
        id: "bad-deriv",
        name: "Bad derivation",
        version: 1,
        stages: [{ kind: "feed", step: "bad.feed" }],
        parameters: [{ name: "x", label: "X", type: "text", derivation: "nonexistentDeriv" }],
      }),
    ).toThrow(/unknown derivation "nonexistentDeriv"/);

    expect(() =>
      resolveJobDefinitionSpec({
        id: "bad-enum",
        name: "Bad enum",
        version: 1,
        stages: [{ kind: "feed", step: "bad.feed" }],
        parameters: [{ name: "x", label: "X", type: "select", enumSource: "nonexistentEnum" }],
      }),
    ).toThrow(/unknown enumSource "nonexistentEnum"/);
  });
});
