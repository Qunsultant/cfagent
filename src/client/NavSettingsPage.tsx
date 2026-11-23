import React, { useState } from "react";
import {
  Button,
  Card,
  CardHeader,
  Flex,
  Notice,
  PageSection,
  PageTemplate,
  TextInput,
  useToast,
} from "./components/ui";
import { DEFAULT_LEFT_NAV_CONFIG } from "./navConfig";
import { isTabFeatureEnabled } from "./featureFlags";
import {
  NAV_PRESET_LABELS,
  leftNavConfigIds,
  type NavPresetKey,
} from "./navPresets";
import type { NavPresetRecord } from "../data/navPresetPorts";
import { NavPresetButtons } from "./components/NavigationMenu";
import { BrokerDynamicMenu, type SettingsMenuProps } from "./BrokerDynamicMenu";

export interface NavSettingsPageProps {
  /** The completed visible-tabs map (all config ids present). */
  visibleTabs: Record<string, boolean>;
  /** The preset the map exactly matches, or null for a custom mix. */
  activePreset: NavPresetKey | null;
  onToggleTabVisibility: (tabId: string) => void;
  onApplyPreset: (key: NavPresetKey) => void;
  /** #6151 S3 — the caller's saved presets (server-side). Absent until the shell wires them. */
  savedPresets?: NavPresetRecord[];
  /** #6151 S3 — the active saved preset id, or null for a custom selection. */
  activeSavedPresetId?: string | null;
  /** #6151 S3 — the localStorage selection S1 adopted, offered once as "save as preset". */
  legacySelection?: Record<string, boolean> | null;
  /** #6151 S3 — save the current selection under a name. */
  onSaveCurrentPreset?: (name: string) => Promise<void>;
  /** #6151 S3 — save the legacy selection under a name. */
  onSaveLegacyPreset?: (name: string) => Promise<void>;
  /** #6151 S3 — drop the legacy selection (the localStorage key is cleared too). */
  onDismissLegacySelection?: () => void;
  /** #6151 S3 — apply a saved preset (server-gated by subscription on apply). */
  onApplySavedPreset?: (id: string) => Promise<void>;
  /** #6151 S3 — rename a saved preset. */
  onRenameSavedPreset?: (id: string, name: string) => Promise<void>;
  /** #6151 S3 — delete a saved preset (the current tabs stay put when the active one goes). */
  onDeleteSavedPreset?: (id: string) => Promise<void>;
  /** Dynamic settings menu props (#3828): rendered inline on this page. */
  settingsMenuProps?: SettingsMenuProps;
}

/**
 * Navigation Settings (issues 3696 S1 + 3697 S2, subs of epic 3695).
 *
 * Nav presets + visible tabs ONLY — per-product settings live in the
 * header Settings menu, not here. Presets are computed from the
 * left-nav config, so the pills below iterate the config (26 items):
 * every toggleable tab gets a pill, including the menu-only and
 * hand-inserted ones (goal-screen, orders, schedules, sandbox) the old
 * menu pills never covered. Route-only ids (checkout, docs, endpoints,
 * ledger, payment-assurance, revenue, workflows) have no pill of their
 * own — they follow their left-nav parent.
 *
 * Primitives only, no bespoke classes: Button variant + aria-pressed
 * carry pill state, CardHeader carries the card headings.
 */
export function NavSettingsPage({
  visibleTabs,
  activePreset,
  onToggleTabVisibility,
  onApplyPreset,
  savedPresets,
  activeSavedPresetId,
  legacySelection,
  onSaveCurrentPreset,
  onSaveLegacyPreset,
  onDismissLegacySelection,
  onApplySavedPreset,
  onRenameSavedPreset,
  onDeleteSavedPreset,
  settingsMenuProps,
}: NavSettingsPageProps) {
  const total = leftNavConfigIds().length;
  const visibleCount = leftNavConfigIds().filter(
    (id) => visibleTabs[id] === true,
  ).length;
  return (
    <PageTemplate
      title="Settings"
      scopeNote="Manage broker, environment, display, ticker, and navigation visibility settings."
    >
      {settingsMenuProps && (
        <PageSection
          title="Platform & Broker Settings"
          description="Broker connection, trading mode, theme, layout, auto-refresh, and ticker tape controls."
        >
          <BrokerDynamicMenu {...settingsMenuProps} variant="page" />
        </PageSection>
      )}
      <PageSection
        title="Presets"
        description="A preset sets every tab at once. Any manual change after that makes the selection custom until a preset matches it again."
      >
        <Card>
          <CardHeader
            title="Navigation presets"
            subtitle={
              activePreset
                ? `Active preset: ${NAV_PRESET_LABELS[activePreset]} — ${visibleCount} of ${total} tabs visible.`
                : `Custom selection — ${visibleCount} of ${total} tabs visible. No preset matches the current tabs.`
            }
          />
          <NavPresetButtons
            activePreset={activePreset}
            onApplyPreset={onApplyPreset}
          />
          {activePreset === "none" && (
            <Notice tone="info" title="Nothing is selected">
              Every navigation tab is hidden in both the left and top
              navigation. Pick any other preset to show tabs again.
            </Notice>
          )}
        </Card>
      </PageSection>
      {onSaveCurrentPreset && (
        <SavedPresetsSection
          savedPresets={savedPresets ?? []}
          activeSavedPresetId={activeSavedPresetId ?? null}
          legacySelection={legacySelection ?? null}
          onSaveCurrentPreset={onSaveCurrentPreset}
          onSaveLegacyPreset={onSaveLegacyPreset}
          onDismissLegacySelection={onDismissLegacySelection}
          onApplySavedPreset={onApplySavedPreset}
          onRenameSavedPreset={onRenameSavedPreset}
          onDeleteSavedPreset={onDeleteSavedPreset}
        />
      )}
      <PageSection
        title="Visible tabs"
        description="Toggle tabs one by one. A hidden tab hides its sub-items too; route-only tabs follow their parent tab."
      >
        {DEFAULT_LEFT_NAV_CONFIG.sections.map((section) => {
          const pills = section.items.filter((item) =>
            isTabFeatureEnabled(item.id),
          );
          if (pills.length === 0) return null;
          const sectionVisible = pills.filter(
            (item) => visibleTabs[item.id] === true,
          ).length;
          return (
            <Card key={section.id}>
              <CardHeader
                title={section.title}
                subtitle={`${sectionVisible} of ${pills.length} visible`}
              />
              <Flex gap="2" wrap>
                {pills.map((item) => {
                  const isVisible = visibleTabs[item.id] === true;
                  return (
                    <Button
                      key={item.id}
                      type="button"
                      variant={isVisible ? "primary" : "secondary"}
                      size="sm"
                      onClick={() => onToggleTabVisibility(item.id)}
                      aria-pressed={isVisible}
                      data-tab-id={item.id}
                      title={`${item.label} (${section.title}): ${isVisible ? "Visible in navigation (click to hide)" : "Hidden from navigation (click to show)"}`}
                    >
                      {isVisible ? "✓ " : "○ "}
                      {item.label}
                    </Button>
                  );
                })}
              </Flex>
            </Card>
          );
        })}
      </PageSection>
    </PageTemplate>
  );
}

/**
 * #6151 S3 — saved named presets, server-side. The 8 fixed presets
 * above stay the computed base; these are the user's own named
 * selections, stored per user and applied through the server so a
 * preset never resurrects a tab the subscription gating removes.
 * Deleting the active preset keeps the current tabs (the selection
 * becomes custom); renaming to an existing name is a 409, surfaced
 * on the field. The legacy offer appears once, while the
 * localStorage selection S1 adopted has no server-side home yet.
 */
function SavedPresetsSection({
  savedPresets,
  activeSavedPresetId,
  legacySelection,
  onSaveCurrentPreset,
  onSaveLegacyPreset,
  onDismissLegacySelection,
  onApplySavedPreset,
  onRenameSavedPreset,
  onDeleteSavedPreset,
}: {
  savedPresets: NavPresetRecord[];
  activeSavedPresetId: string | null;
  legacySelection: Record<string, boolean> | null;
  onSaveCurrentPreset: (name: string) => Promise<void>;
  onSaveLegacyPreset?: (name: string) => Promise<void>;
  onDismissLegacySelection?: () => void;
  onApplySavedPreset?: (id: string) => Promise<void>;
  onRenameSavedPreset?: (id: string, name: string) => Promise<void>;
  onDeleteSavedPreset?: (id: string) => Promise<void>;
}) {
  const toast = useToast();
  const [name, setName] = useState("");
  const [nameError, setNameError] = useState<string | undefined>(undefined);
  const [busy, setBusy] = useState(false);
  const [renamingId, setRenamingId] = useState<string | null>(null);
  const [renameName, setRenameName] = useState("");
  const [renameError, setRenameError] = useState<string | undefined>(undefined);
  const showLegacyOffer =
    legacySelection !== null && activeSavedPresetId === null;

  const run = async (
    work: () => Promise<void>,
    onDone: () => void,
    setFieldError?: (message: string | undefined) => void,
  ) => {
    if (busy) return;
    setBusy(true);
    try {
      await work();
      onDone();
    } catch (err) {
      const code = (err as { code?: unknown }).code;
      if (code === "FAILURE_NAV_PRESET_CONFLICT" && setFieldError) {
        setFieldError("A preset with that name already exists.");
      } else {
        toast.danger(
          typeof code === "string" ? code : "Could not save the preset.",
          "Preset not saved",
        );
      }
    } finally {
      setBusy(false);
    }
  };

  const saveCurrent = () => {
    const clean = name.trim();
    if (clean.length === 0) {
      setNameError("Give the preset a name.");
      return;
    }
    setNameError(undefined);
    void run(
      () => onSaveCurrentPreset(clean),
      () => {
        setName("");
        toast.success(`Preset “${clean}” saved.`, "Preset saved");
      },
      setNameError,
    );
  };

  const saveLegacy = () => {
    if (!onSaveLegacyPreset) return;
    const clean = name.trim();
    if (clean.length === 0) {
      setNameError("Give the preset a name.");
      return;
    }
    setNameError(undefined);
    void run(
      () => onSaveLegacyPreset(clean),
      () => {
        setName("");
        toast.success(`Preset “${clean}” saved.`, "Preset saved");
      },
      setNameError,
    );
  };

  return (
    <PageSection
      title="Saved presets"
      description="Name the current selection to keep it. Saved presets live on the server, so they follow you across devices — and applying one never brings back a tab your subscription no longer includes."
    >
      <Card>
        <CardHeader
          title="Your presets"
          subtitle={
            savedPresets.length === 0
              ? "No saved presets yet."
              : `${savedPresets.length} saved preset${savedPresets.length === 1 ? "" : "s"}.`
          }
        />
        {showLegacyOffer && (
          <Notice tone="info" title="Your previous selection is still on this device">
            Before presets were saved on the server, your selection lived
            only here. Save it under a name to keep it, or dismiss it —
            your current tabs stay as they are either way.
          </Notice>
        )}
        <Flex gap="2" wrap>
          <TextInput
            label="Preset name"
            value={name}
            onChange={(event) => {
              setName(event.target.value);
              setNameError(undefined);
              setRenameError(undefined);
            }}
            error={nameError}
            maxLength={80}
            placeholder="e.g. Morning trading"
          />
          <Button
            type="button"
            variant="primary"
            size="sm"
            onClick={saveCurrent}
            disabled={busy || name.trim().length === 0}
          >
            Save current selection
          </Button>
          {showLegacyOffer && onSaveLegacyPreset && (
            <Button
              type="button"
              variant="secondary"
              size="sm"
              onClick={saveLegacy}
              disabled={busy || name.trim().length === 0}
            >
              Save previous selection
            </Button>
          )}
          {showLegacyOffer && onDismissLegacySelection && (
            <Button
              type="button"
              variant="secondary"
              size="sm"
              onClick={onDismissLegacySelection}
              disabled={busy}
            >
              Dismiss
            </Button>
          )}
        </Flex>
        {savedPresets.length > 0 && (
          <Flex gap="2" wrap>
            {savedPresets.map((preset) => {
              const isActive = preset.id === activeSavedPresetId;
              const isRenaming = renamingId === preset.id;
              return (
                <Flex key={preset.id} gap="2" wrap>
                  {isRenaming ? (
                    <>
                      <TextInput
                        label={`Rename “${preset.name}”`}
                        value={renameName}
                        onChange={(event) => {
                          setRenameName(event.target.value);
                          setRenameError(undefined);
                        }}
                        error={renameError}
                        maxLength={80}
                      />
                      <Button
                        type="button"
                        variant="primary"
                        size="sm"
                        disabled={busy || renameName.trim().length === 0}
                        onClick={() => {
                          const clean = renameName.trim();
                          if (clean.length === 0) {
                            setRenameError("Give the preset a name.");
                            return;
                          }
                          if (!onRenameSavedPreset) return;
                          void run(
                            () => onRenameSavedPreset(preset.id, clean),
                            () => {
                              setRenamingId(null);
                              setRenameName("");
                              toast.success(`Preset renamed to “${clean}”.`, "Preset renamed");
                            },
                            setRenameError,
                          );
                        }}
                      >
                        Save name
                      </Button>
                      <Button
                        type="button"
                        variant="secondary"
                        size="sm"
                        onClick={() => {
                          setRenamingId(null);
                          setRenameName("");
                          setRenameError(undefined);
                        }}
                      >
                        Cancel
                      </Button>
                    </>
                  ) : (
                    <>
                      <Button
                        type="button"
                        variant={isActive ? "primary" : "secondary"}
                        size="sm"
                        aria-pressed={isActive}
                        disabled={busy}
                        onClick={() => {
                          if (!onApplySavedPreset) return;
                          void run(
                            () => onApplySavedPreset(preset.id),
                            () => {
                              toast.success(
                                `Preset “${preset.name}” applied.`,
                                "Preset applied",
                              );
                            },
                          );
                        }}
                        title={
                          isActive
                            ? `${preset.name} (active preset)`
                            : `Apply ${preset.name}`
                        }
                      >
                        {isActive ? "✓ " : ""}
                        {preset.name}
                      </Button>
                      <Button
                        type="button"
                        variant="secondary"
                        size="sm"
                        disabled={busy}
                        onClick={() => {
                          setRenamingId(preset.id);
                          setRenameName(preset.name);
                          setRenameError(undefined);
                        }}
                      >
                        Rename
                      </Button>
                      <Button
                        type="button"
                        variant="danger"
                        size="sm"
                        disabled={busy}
                        onClick={() => {
                          if (!onDeleteSavedPreset) return;
                          void run(
                            () => onDeleteSavedPreset(preset.id),
                            () => {
                              toast.success(
                                `Preset “${preset.name}” deleted. Your current tabs are unchanged.`,
                                "Preset deleted",
                              );
                            },
                          );
                        }}
                      >
                        Delete
                      </Button>
                    </>
                  )}
                </Flex>
              );
            })}
          </Flex>
        )}
      </Card>
    </PageSection>
  );
}
