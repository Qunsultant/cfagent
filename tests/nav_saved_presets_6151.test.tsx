// @vitest-environment jsdom
/**
 * #6151 S3 — the Saved presets section on the settings page.
 *
 * Rendered with the section wired (saved presets + handlers from
 * Chat.tsx's shape, stubbed): the save form validates (an empty
 * name errors on the field, never calls the handler), a duplicate
 * name surfaces the 409 on the field, apply/rename/delete call
 * their handlers, the active preset is marked, and the legacy
 * offer appears only while a legacy selection exists and no saved
 * preset is active. Without the S3 props the section is absent
 * (the S1 page is unchanged).
 */
import React, { act } from "react";
import { createRoot, type Root } from "react-dom/client";
import { describe, it, expect, vi, afterEach } from "vitest";
import { NavSettingsPage } from "../src/client/NavSettingsPage";
import { ToastProvider } from "../src/client/components/ui/Toast";
import { expandPresetKey } from "../src/client/navPresets";
import type { NavPresetRecord } from "../src/data/navPresetPorts";

let container: HTMLDivElement;
let root: Root;

async function flush(ms = 40) {
  await act(async () => {
    await new Promise((resolve) => setTimeout(resolve, ms));
  });
}

async function render(node: React.ReactNode) {
  container = document.createElement("div");
  document.body.appendChild(container);
  root = createRoot(container);
  await act(async () => {
    root.render(<ToastProvider>{node}</ToastProvider>);
  });
  await flush();
}

afterEach(() => {
  if (root) root.unmount();
  if (container) container.remove();
  vi.restoreAllMocks();
});

function preset(id: string, name: string): NavPresetRecord {
  return {
    id,
    userId: "user-1",
    name,
    map: expandPresetKey("research"),
    createdAtMs: 1,
    updatedAtMs: 1,
  };
}

function pageProps(overrides: Record<string, unknown> = {}) {
  return {
    visibleTabs: expandPresetKey("alltabs"),
    activePreset: "alltabs" as const,
    onToggleTabVisibility: vi.fn(),
    onApplyPreset: vi.fn(),
    savedPresets: [preset("preset-aaaa0001", "Morning"), preset("preset-aaaa0002", "Evening")],
    activeSavedPresetId: "preset-aaaa0001",
    legacySelection: null,
    onSaveCurrentPreset: vi.fn().mockResolvedValue(undefined),
    onSaveLegacyPreset: vi.fn().mockResolvedValue(undefined),
    onDismissLegacySelection: vi.fn(),
    onApplySavedPreset: vi.fn().mockResolvedValue(undefined),
    onRenameSavedPreset: vi.fn().mockResolvedValue(undefined),
    onDeleteSavedPreset: vi.fn().mockResolvedValue(undefined),
    ...overrides,
  };
}

function setInputValue(input: HTMLInputElement, value: string) {
  const setter = Object.getOwnPropertyDescriptor(window.HTMLInputElement.prototype, "value")!.set!;
  setter.call(input, value);
  input.dispatchEvent(new Event("input", { bubbles: true }));
}

function inputByLabel(label: string): HTMLInputElement {
  const labelEl = [...container.querySelectorAll("label")].find(
    (el) => el.textContent?.trim() === label,
  );
  if (!labelEl) throw new Error(`no label ${label}`);
  const el = container.querySelector(`#${labelEl.htmlFor}`) as HTMLInputElement | null;
  if (!el) throw new Error(`no input for label ${label}`);
  return el;
}

function buttonByText(text: string): HTMLButtonElement {
  const el = [...container.querySelectorAll("button")].find(
    (b) => b.textContent?.trim() === text,
  );
  if (!el) throw new Error(`no button labelled ${text}`);
  return el;
}

describe("NavSettingsPage saved presets (#6151 S3)", () => {
  it("renders the saved presets with the active one marked, and no legacy offer", async () => {
    await render(<NavSettingsPage {...pageProps()} />);
    expect(container.textContent).toContain("Your presets");
    expect(container.textContent).toContain("Morning");
    expect(container.textContent).toContain("Evening");
    expect(container.textContent).not.toContain("Your previous selection");
    const active = buttonByText("✓ Morning");
    expect(active.getAttribute("aria-pressed")).toBe("true");
  });

  it("is absent without the S3 props (the S1 page is unchanged)", async () => {
    await render(
      <NavSettingsPage
        visibleTabs={expandPresetKey("alltabs")}
        activePreset="alltabs"
        onToggleTabVisibility={vi.fn()}
        onApplyPreset={vi.fn()}
      />,
    );
    expect(container.textContent).not.toContain("Your presets");
    expect(container.textContent).not.toContain("Saved presets");
  });

  it("the save button stays disabled with an empty name and never calls the handler", async () => {
    const onSaveCurrentPreset = vi.fn().mockResolvedValue(undefined);
    await render(<NavSettingsPage {...pageProps({ onSaveCurrentPreset })} />);
    expect(buttonByText("Save current selection").disabled).toBe(true);
    await act(async () => {
      buttonByText("Save current selection").click();
    });
    await flush();
    expect(onSaveCurrentPreset).not.toHaveBeenCalled();
  });

  it("saving with a name calls the handler; a 409 surfaces on the field", async () => {
    const onSaveCurrentPreset = vi.fn().mockResolvedValue(undefined);
    await render(<NavSettingsPage {...pageProps({ onSaveCurrentPreset })} />);
    await act(async () => {
      setInputValue(inputByLabel("Preset name"), "Night");
    });
    await act(async () => {
      buttonByText("Save current selection").click();
    });
    await flush();
    expect(onSaveCurrentPreset).toHaveBeenCalledWith("Night");

    const conflict = vi.fn().mockRejectedValue(
      Object.assign(new Error("FAILURE_NAV_PRESET_CONFLICT"), {
        code: "FAILURE_NAV_PRESET_CONFLICT",
      }),
    );
    await render(<NavSettingsPage {...pageProps({ onSaveCurrentPreset: conflict })} />);
    await act(async () => {
      setInputValue(inputByLabel("Preset name"), "Morning");
    });
    await act(async () => {
      buttonByText("Save current selection").click();
    });
    await flush();
    expect(container.textContent).toContain("A preset with that name already exists.");
  });

  it("apply / rename / delete call their handlers", async () => {
    const onApplySavedPreset = vi.fn().mockResolvedValue(undefined);
    const onRenameSavedPreset = vi.fn().mockResolvedValue(undefined);
    const onDeleteSavedPreset = vi.fn().mockResolvedValue(undefined);
    await render(
      <NavSettingsPage
        {...pageProps({ onApplySavedPreset, onRenameSavedPreset, onDeleteSavedPreset })}
      />,
    );
    await act(async () => {
      buttonByText("Evening").click();
    });
    await flush();
    expect(onApplySavedPreset).toHaveBeenCalledWith("preset-aaaa0002");

    const renameButtons = [...container.querySelectorAll("button")].filter(
      (b) => b.textContent?.trim() === "Rename",
    );
    expect(renameButtons.length).toBe(2);
    await act(async () => {
      renameButtons[0].click();
    });
    await flush();
    await act(async () => {
      setInputValue(inputByLabel("Rename “Morning”"), "Dawn");
    });
    await act(async () => {
      buttonByText("Save name").click();
    });
    await flush();
    expect(onRenameSavedPreset).toHaveBeenCalledWith("preset-aaaa0001", "Dawn");

    const deleteButtons = [...container.querySelectorAll("button")].filter(
      (b) => b.textContent?.trim() === "Delete",
    );
    await act(async () => {
      deleteButtons[1].click();
    });
    await flush();
    expect(onDeleteSavedPreset).toHaveBeenCalledWith("preset-aaaa0002");
  });

  it("shows the legacy offer only while a legacy selection exists and no preset is active", async () => {
    const onSaveLegacyPreset = vi.fn().mockResolvedValue(undefined);
    const onDismissLegacySelection = vi.fn();
    await render(
      <NavSettingsPage
        {...pageProps({
          activeSavedPresetId: null,
          legacySelection: expandPresetKey("research"),
          onSaveLegacyPreset,
          onDismissLegacySelection,
        })}
      />,
    );
    expect(container.textContent).toContain("Your previous selection is still on this device");
    await act(async () => {
      setInputValue(inputByLabel("Preset name"), "Old setup");
    });
    await act(async () => {
      buttonByText("Save previous selection").click();
    });
    await flush();
    expect(onSaveLegacyPreset).toHaveBeenCalledWith("Old setup");
    await act(async () => {
      buttonByText("Dismiss").click();
    });
    expect(onDismissLegacySelection).toHaveBeenCalled();
  });
});
