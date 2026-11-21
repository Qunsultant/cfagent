/**
 * Issue #5993 (#5965 slice 2) — the tenant-settings data-provider picker reads
 * the whole-set vocabulary (#5515).
 *
 * Before this pin the provider was a free-text field in
 * `src/client/TenantAdminPanel.tsx`: no picker, no label, no validation, so an
 * operator could store any string and the vocabulary was never consulted. The
 * options now come from `providerOptions()` in `src/client/vocabularyOptions.ts`,
 * so the pin asserts the list's *content* (what an operator may choose), the
 * legacy row that keeps a stored unknown id visible, and the data-only addition
 * — plus that the panel takes its options from the reader instead of a field of
 * its own.
 */
import { readFileSync } from "node:fs";
import { afterEach, describe, expect, it } from "vitest";
import { brokerOptions, providerOptions } from "../src/client/vocabularyOptions";
import { axisIds, getVocabulary, setVocabulary, type Vocabulary } from "../src/config/vocabulary";

afterEach(() => setVocabulary(null));

function copyOf(vocab: Vocabulary): Vocabulary {
  return {
    version: vocab.version,
    defaults: { ...vocab.defaults },
    axes: Object.fromEntries(
      Object.entries(vocab.axes).map(([axis, entries]) => [axis, entries.map((e) => ({ ...e }))]),
    ) as Vocabulary["axes"],
    conflations: vocab.conflations.map((c) => ({ ...c })),
    // #5494: the provider × dataset matrix travels with the copy, or the
    // overridden registry would lose the served pairs.
    providerDatasets: vocab.providerDatasets.map((p) => ({ ...p })),
  };
}

describe("#5993 provider options come from the vocabulary", () => {
  it("P01 the picker offers exactly the registry's provider ids, in registry order", () => {
    const values = providerOptions().map((o) => o.value);
    expect(values).toEqual(axisIds("provider"));
  });

  it("P02 every option carries the registry's label, not the raw id", () => {
    const labels = new Map(providerOptions().map((o) => [o.value, o.label]));
    for (const entry of getVocabulary().axes.provider) {
      expect(labels.get(entry.id), entry.id).toBe(entry.label);
    }
  });

  it("P03 a stored provider the registry no longer holds renders as legacy", () => {
    const options = providerOptions("retiredfeed");
    const legacy = options.find((o) => o.value === "retiredfeed");
    expect(legacy).toBeDefined();
    // The select is controlled by the stored id, so the option must carry
    // exactly that value — otherwise the control renders blank.
    expect(legacy?.label).toBe("retiredfeed (legacy)");
    expect(legacy?.legacy).toBe(true);
    // A known value is not duplicated, and no current value means no extra row.
    const known = axisIds("provider")[0];
    expect(providerOptions(known)).toHaveLength(axisIds("provider").length);
    expect(providerOptions(undefined)).toHaveLength(axisIds("provider").length);
  });

  it("P04 data, not JSX: a provider added to the registry appears with no component change", () => {
    const vocab = copyOf(getVocabulary());
    vocab.axes.provider = [
      ...vocab.axes.provider,
      { id: "examplefeed", label: "Example Feed", kind: "pure" },
    ];
    setVocabulary(vocab);
    const option = providerOptions().find((o) => o.value === "examplefeed");
    expect(option).toBeDefined();
    expect(option?.label).toBe("Example Feed");
    expect(providerOptions().map((o) => o.value)).toEqual(axisIds("provider"));
  });

  it("P05 the broker axis reads the same reader (registry labels + a legacy row)", () => {
    expect(brokerOptions().map((o) => o.value)).toEqual(axisIds("broker"));
    const labels = new Map(brokerOptions().map((o) => [o.value, o.label]));
    for (const entry of getVocabulary().axes.broker) {
      expect(labels.get(entry.id), entry.id).toBe(entry.label);
    }
    const legacy = brokerOptions("retiredbroker").find((o) => o.value === "retiredbroker");
    expect(legacy?.label).toBe("retiredbroker (legacy)");
    expect(legacy?.legacy).toBe(true);
  });

  it("P06 the panel takes the provider from the reader, not a free-text field", () => {
    const source = readFileSync("src/client/TenantAdminPanel.tsx", "utf8");
    // The field renders registry options…
    expect(source).toContain("providerOptions(");
    expect(source).toContain('label="Data provider"');
    // …and the free-text field it replaced is gone.
    expect(source).not.toContain("Data provider id");
  });
});
