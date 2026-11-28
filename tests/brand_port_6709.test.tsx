/** @vitest-environment jsdom */
/**
 * Brand manifest + BrandPort pins (issue #6709).
 *
 * The SupraLab/SupraHub brand lives in `config/brand.json` — the single
 * source of truth. App code reads it ONLY through the BrandPort
 * (`src/config/brand.ts`, JSON adapter for now; a D1 adapter lands later
 * with zero app change). The CapabilityMapView renders from the port.
 *
 * Pins in this file:
 * - manifest shape: thirteen capabilities in draft order, statuses per
 *   docs/architecture/enterprise/supralab.md §4, pipeline, footer,
 *   handles, logo.
 * - port conformance: JsonBrandAdapter satisfies the BrandPort contract.
 * - validation: a bad manifest is rejected and the live one survives.
 * - brand census (runtime sources only): no Supra/NextGenTP/OpenAIMP
 *   literal in the map component or the port — the manifest is the only
 *   place those names live. The expected values below are the pin data
 *   itself, not app code.
 * - rename drill: different names in the manifest render on the map,
 *   no old names remain.
 */
import { describe, it, expect, afterEach } from "vitest";
import { readFileSync } from "node:fs";
import React from "react";
import { act } from "react";
import { createRoot } from "react-dom/client";
import {
  JsonBrandAdapter,
  getBrandManifest,
  getBrandPort,
  setBrandManifest,
  validateBrandManifest,
  type BrandManifest,
} from "../src/config/brand";
import brandJson from "../config/brand.json";
import { CapabilityMapView } from "../src/client/CapabilityMapView";

(globalThis as any).IS_REACT_ACT_ENVIRONMENT = true;

const ORIGINAL_MANIFEST: BrandManifest = JSON.parse(JSON.stringify(brandJson));

const CAPABILITY_KEYS = [
  "supraflo",
  "supratik",
  "supraque",
  "supratap",
  "suprabox",
  "suprasim",
  "suprakno",
  "supraud",
  "suprasyn",
  "supraexe",
  "supracap",
  "suprapre",
  "supralin",
];

afterEach(() => {
  setBrandManifest(ORIGINAL_MANIFEST);
});

describe("brand manifest (issue #6709)", () => {
  it("has thirteen capabilities in draft order, with the supralab §4 statuses", () => {
    const manifest = getBrandManifest();
    expect(manifest.version).toBe(1);
    expect(manifest.capabilities.map((capability) => capability.key)).toEqual(CAPABILITY_KEYS);
    expect(
      Object.fromEntries(manifest.capabilities.map((capability) => [capability.key, capability.status])),
    ).toEqual({
      supraflo: "available",
      supratik: "available",
      supraque: "partial",
      supratap: "partial",
      suprabox: "partial",
      suprasim: "partial",
      suprakno: "partial",
      supraud: "partial",
      suprasyn: "not-available",
      supraexe: "partial",
      supracap: "partial",
      suprapre: "partial",
      supralin: "partial",
    });
  });

  it("carries the company, platform, pipeline, footer, handles, and logo", () => {
    const manifest = getBrandManifest();
    expect(manifest.company).toEqual({
      name: "SupraLab",
      shortName: "SupraLab",
      description: "The company. Owns the platform, the brand, and the operator relationship.",
    });
    expect(manifest.platform.name).toBe("SupraHub");
    expect(manifest.platform.shortName).toBe("SupraHub");
    expect(manifest.platform.description).toBe(
      "The platform — the boundary containing the thirteen capabilities below. It is not a fourteenth capability and not an executor.",
    );
    expect(manifest.pipeline).toEqual(["supratap", "suprabox", "suprasim", "supraud", "supracap", "supraexe"]);
    expect(manifest.pipelineNote).toBe(
      "SupraPre gates SupraExe · SupraLin observes all · SupraFlo is the only executor",
    );
    // Footer is the CURRENT text — the proposed Supra wording is an
    // undecided owner decision and is never defaulted here.
    expect(manifest.emailFooter).toBe("OpenAIMP Agentic Trading Network • agent.openaimp.com");
    expect(manifest.socialHandles).toHaveLength(11);
    expect(manifest.socialHandles.map((handle) => handle.platform)).toEqual([
      "GitHub",
      "Discord",
      "X",
      "YouTube",
      "Telegram",
      "LinkedIn",
      "Reddit",
      "Bluesky",
      "Threads",
      "Instagram",
      "TikTok",
    ]);
    expect(manifest.logo).toBeNull();
  });

  it("pins the draft definitions and the map-only capabilities", () => {
    const manifest = getBrandManifest();
    const byKey = new Map(manifest.capabilities.map((capability) => [capability.key, capability]));
    expect(byKey.get("supraflo")?.description).toBe(
      "Workflow execution — the only executor in the platform.",
    );
    expect(byKey.get("supraflo")?.route).toEqual({ tab: "workflow-runs" });
    expect(byKey.get("suprabox")?.route).toEqual({ tab: "stock-hub", view: "research" });
    expect(byKey.get("suprakno")?.surfaces).toEqual([
      { label: "Docs & Reports", tab: "docs" },
      { label: "Search", tab: "search" },
    ]);
    // Map-only by design: no user surface, no route.
    for (const key of ["supraque", "suprasyn"]) {
      expect(byKey.get(key)?.route).toBeNull();
      expect(byKey.get(key)?.surfaces).toEqual([]);
    }
  });
});

describe("BrandPort conformance (issue #6709)", () => {
  it("JsonBrandAdapter satisfies the port contract", () => {
    const port = new JsonBrandAdapter();
    expect(port.getBrand()).toBe(getBrandManifest());
    expect(port.getCapability("supraflo")?.displayName).toBe("SupraFlo");
    expect(port.getCapability("suprasyn")?.status).toBe("not-available");
    expect(port.getCapability("no-such-capability")).toBeUndefined();
    expect(port.getAllCapabilities().map((capability) => capability.key)).toEqual(CAPABILITY_KEYS);
    expect(getBrandPort()).toBeInstanceOf(JsonBrandAdapter);
  });

  it("validation rejects a bad manifest and keeps the live one", () => {
    expect(() => validateBrandManifest({ ...ORIGINAL_MANIFEST, version: 2 })).toThrow();
    const badStatus = JSON.parse(JSON.stringify(ORIGINAL_MANIFEST)) as BrandManifest;
    (badStatus.capabilities[0] as unknown as Record<string, unknown>).status = "live";
    expect(() => validateBrandManifest(badStatus)).toThrow();
    const duplicateKey = JSON.parse(JSON.stringify(ORIGINAL_MANIFEST)) as BrandManifest;
    duplicateKey.capabilities[1].key = duplicateKey.capabilities[0].key;
    expect(() => validateBrandManifest(duplicateKey)).toThrow();
    const badPipeline = JSON.parse(JSON.stringify(ORIGINAL_MANIFEST)) as BrandManifest;
    badPipeline.pipeline = ["supratap", "no-such-capability"];
    expect(() => validateBrandManifest(badPipeline)).toThrow();
    expect(() => setBrandManifest(badPipeline)).toThrow();
    expect(getBrandManifest().capabilities).toHaveLength(13);
  });
});

describe("brand census (issue #6709)", () => {
  it("no brand literal in the map component or the port outside the manifest", () => {
    const stripComments = (source: string): string =>
      source
        .replace(/\/\*[\s\S]*?\*\//g, "")
        .replace(/(^|\s)\/\/.*$/gm, "$1");
    for (const file of ["src/client/CapabilityMapView.tsx", "src/config/brand.ts"]) {
      const source = stripComments(readFileSync(file, "utf8"));
      for (const literal of ["Supra", "NextGenTP", "OpenAIMP"]) {
        expect(source, `${file} must not hardcode ${literal}`).not.toContain(literal);
      }
    }
  });
});

describe("rename drill (issue #6709)", () => {
  it("different names in the manifest render on the map, no old names remain", async () => {
    const replacements: Array<[string, string]> = [
      ["SupraLab", "RenamedLab"],
      ["SupraHub", "RenamedHub"],
      ["SupraFlo", "RenamedFlo"],
      ["SupraTik", "RenamedTik"],
      ["SupraQue", "RenamedQue"],
      ["SupraTap", "RenamedTap"],
      ["SupraBox", "RenamedBox"],
      ["SupraSim", "RenamedSim"],
      ["SupraKno", "RenamedKno"],
      ["SupraAud", "RenamedAud"],
      ["SupraSyn", "RenamedSyn"],
      ["SupraExe", "RenamedExe"],
      ["SupraCap", "RenamedCap"],
      ["SupraPre", "RenamedPre"],
      ["SupraLin", "RenamedLin"],
    ];
    let serialized = JSON.stringify(ORIGINAL_MANIFEST);
    for (const [oldName, newName] of replacements) {
      serialized = serialized.split(oldName).join(newName);
    }
    setBrandManifest(JSON.parse(serialized) as BrandManifest);

    const container = document.createElement("div");
    document.body.appendChild(container);
    const root = createRoot(container);
    try {
      await act(async () => {
        root.render(<CapabilityMapView onNavigateTab={() => {}} />);
      });
      const text = container.textContent ?? "";
      for (const [, newName] of replacements) {
        expect(text).toContain(newName);
      }
      for (const [oldName] of replacements) {
        expect(text).not.toContain(oldName);
      }
    } finally {
      await act(async () => {
        root.unmount();
      });
      container.remove();
    }
  });
});
