/**
 * Issue #1497 (#940-C): preset save/load/delete UI for the manual run
 * form. Builds on #1495 (preset API) and #1496 (criteria panel).
 *
 * Built ONLY from src/client/components/ui/ primitives (Card,
 * FieldShell, TextInput, Button, Notice, EmptyState, Modal) — no raw
 * HTML controls, no hand-rolled cards/modals.
 *
 * Wire-format decision: manual runs do NOT carry presetId. The run
 * request schema is z.strictObject, so an extra presetId field would
 * 400. Instead Load resolves client-side: it re-lists, applies the
 * preset's criteria into the panel via onApplyPreset, and the form's
 * existing Run button sends those criteria. Server-side preset
 * resolution for scheduled runs is #1499's contract, not this UI's.
 *
 * "Missing/foreign preset fails loudly, never a silent default":
 *  - Load re-lists before applying. If the id is gone (deleted
 *    elsewhere), Load errors loudly, refreshes the list, and applies
 *    NOTHING — the panel keeps its previous criteria.
 *  - A failed list fetch shows the server's business error, never an
 *    empty list masquerading as "no presets".
 *  - With no preset selected, the run uses the panel's explicit state
 *    (all-off = existing behavior) — never a substituted preset.
 *  - Foreign presets cannot appear: the API lists only the caller's own
 *    rows, and deleting another user's id 404s (pinned in #1495).
 *  - Delete asks for Modal confirmation naming the exact preset.
 */

import React, { useCallback, useEffect, useState } from "react";
import type { OptionScreenerFilter, StockScreenerFilter } from "../types";
import { apiFetch as fetch } from "./apiFetch";
import { Card } from "./components/ui/Card";
import { Flex } from "./components/ui/Flex";
import { Stack } from "./components/ui/Stack";
import { PageSection } from "./components/ui/PageShell";
import { FieldShell } from "./components/ui/Field";
import { TextInput } from "./components/ui/TextInput";
import { Button } from "./components/ui/Button";
import { Notice } from "./components/ui/Notice";
import { EmptyState } from "./components/ui/EmptyState";
import { Modal } from "./components/ui/Modal";
import { Badge } from "./components/ui/Badge";
import {
  stockFilterToCriteria,
  type StockCriteriaState,
} from "./StockCriteriaPanel";

export interface ScreenerPreset {
  id: string;
  name: string;
  assetClass: string;
  criteria: Record<string, unknown>;
  createdAt: string;
  updatedAt: string;
}

function headers(userLogin?: string): Record<string, string> {
  return {
    "Content-Type": "application/json",
    ...(userLogin ? { "x-user-login": userLogin } : {}),
  };
}

async function readError(response: Response, fallback: string): Promise<string> {
  try {
    const body = (await response.json()) as { error?: unknown };
    if (typeof body.error === "string" && body.error) return body.error;
  } catch {
    // Fall through to the status fallback below.
  }
  return `${fallback} [HTTP ${response.status}]`;
}

function toPreset(raw: Record<string, unknown>): ScreenerPreset {
  return {
    id: String(raw.id ?? ""),
    name: String(raw.name ?? ""),
    assetClass: String(raw.assetClass ?? ""),
    criteria:
      raw.criteria !== null && typeof raw.criteria === "object" && !Array.isArray(raw.criteria)
        ? (raw.criteria as Record<string, unknown>)
        : {},
    createdAt: String(raw.createdAt ?? ""),
    updatedAt: String(raw.updatedAt ?? ""),
  };
}

export async function listPresets(userLogin?: string): Promise<ScreenerPreset[]> {
  const response = await fetch("/api/screener/presets", { headers: headers(userLogin) });
  if (!response.ok) throw new Error(await readError(response, "Failed to list presets."));
  const body = (await response.json()) as { presets?: unknown };
  if (!Array.isArray(body.presets)) return [];
  return body.presets
    .filter((p): p is Record<string, unknown> => p !== null && typeof p === "object")
    .map(toPreset);
}

export async function createPreset(
  userLogin: string | undefined,
  // Issue #1498 (#940-D): both asset classes' criteria flow through Save;
  // the server validates them with the run path's own strict parsers.
  input: { name: string; assetClass: string; criteria: StockScreenerFilter | OptionScreenerFilter }
): Promise<ScreenerPreset> {
  const response = await fetch("/api/screener/presets", {
    method: "POST",
    headers: headers(userLogin),
    body: JSON.stringify(input),
  });
  if (!response.ok) throw new Error(await readError(response, "Failed to save preset."));
  const body = (await response.json()) as { preset?: Record<string, unknown> };
  if (!body.preset || typeof body.preset !== "object") {
    throw new Error("Failed to save preset.");
  }
  return toPreset(body.preset);
}

export async function deletePreset(userLogin: string | undefined, id: string): Promise<void> {
  const response = await fetch(`/api/screener/presets/${encodeURIComponent(id)}`, {
    method: "DELETE",
    headers: headers(userLogin),
  });
  if (!response.ok) throw new Error(await readError(response, "Failed to delete preset."));
}

export interface ScreenerPresetManagerProps<C> {
  assetClass: "stocks" | "options";
  userLogin?: string;
  /** Current run filter (from the criteria panel) used by Save. */
  currentFilter: StockScreenerFilter | OptionScreenerFilter;
  /** Applies a loaded preset's criteria into the criteria panel. */
  onApplyPreset: (criteria: C) => void;
  /**
   * Issue #1498 (#940-D): maps a stored preset filter onto panel state.
   * Defaults to the stocks mapper, so the #1497 stocks call site is
   * unchanged; options call sites pass optionsFilterToCriteria.
   */
  filterToCriteria?: (filter: Record<string, unknown>) => C;
}

export function ScreenerPresetManager<C>({
  assetClass,
  userLogin,
  currentFilter,
  onApplyPreset,
  filterToCriteria,
}: ScreenerPresetManagerProps<C>) {
  const [presets, setPresets] = useState<ScreenerPreset[]>([]);
  const [loading, setLoading] = useState(true);
  const [error, setError] = useState("");
  const [notice, setNotice] = useState("");
  const [name, setName] = useState("");
  const [saving, setSaving] = useState(false);
  const [deleting, setDeleting] = useState(false);
  const [confirmDelete, setConfirmDelete] = useState<ScreenerPreset | null>(null);

  const load = useCallback(async () => {
    setLoading(true);
    try {
      setPresets(await listPresets(userLogin));
      setError("");
    } catch (cause) {
      setError(cause instanceof Error ? cause.message : "Failed to list presets.");
    } finally {
      setLoading(false);
    }
  }, [userLogin]);

  useEffect(() => {
    void load();
  }, [load]);

  const visible = presets.filter((preset) => preset.assetClass === assetClass);

  const handleLoad = async (preset: ScreenerPreset) => {
    setError("");
    setNotice("");
    try {
      const fresh = await listPresets(userLogin);
      setPresets(fresh);
      const found = fresh.find((p) => p.id === preset.id);
      if (!found) {
        throw new Error(
          `Preset "${preset.name}" no longer exists — the list has been refreshed.`
        );
      }
      if (filterToCriteria) {
        onApplyPreset(filterToCriteria(found.criteria));
      } else {
        onApplyPreset(
          stockFilterToCriteria(found.criteria as unknown as StockScreenerFilter) as unknown as C
        );
      }
      setNotice(`Preset "${found.name}" loaded into the criteria panel.`);
    } catch (cause) {
      setError(cause instanceof Error ? cause.message : "Failed to load preset.");
    }
  };

  const handleSave = async () => {
    const trimmed = name.trim();
    if (trimmed === "" || saving) return;
    setError("");
    setNotice("");
    setSaving(true);
    try {
      const saved = await createPreset(userLogin, {
        name: trimmed,
        assetClass,
        criteria: currentFilter,
      });
      setName("");
      setNotice(`Preset "${saved.name}" saved.`);
      await load();
    } catch (cause) {
      setError(cause instanceof Error ? cause.message : "Failed to save preset.");
    } finally {
      setSaving(false);
    }
  };

  const handleDelete = async () => {
    if (!confirmDelete || deleting) return;
    const target = confirmDelete;
    setDeleting(true);
    try {
      await deletePreset(userLogin, target.id);
      setConfirmDelete(null);
      setNotice(`Preset "${target.name}" deleted.`);
      await load();
    } catch (cause) {
      setConfirmDelete(null);
      setError(cause instanceof Error ? cause.message : "Failed to delete preset.");
    } finally {
      setDeleting(false);
    }
  };

  return (
    <PageSection title="Saved presets">
    <Card>
      {visible.length > 0 && (
        <Flex justify="between" align="center">
          <Badge tone="accent" size="sm">
            {visible.length} preset{visible.length === 1 ? "" : "s"}
          </Badge>
        </Flex>
      )}
      <p style={{ fontSize: "var(--font-size-body)", color: "var(--color-text-muted)", marginBottom: "0.75rem" }}>
        Save the current criteria to reuse them later. Loading a preset puts
        its criteria into the panel; the form&apos;s Run button then sends
        them. Runs never carry a preset id — the run request schema would
        reject it.
      </p>
      {error && <Notice tone="danger">{error}</Notice>}
      {notice && <Notice tone="success">{notice}</Notice>}
      {loading ? (
        <p style={{ color: "var(--color-text-muted)" }}>Loading presets…</p>
      ) : error ? (
        <p style={{ color: "var(--color-danger)" }}>Presets could not be loaded.</p>
      ) : visible.length === 0 ? (
        <EmptyState
          title="No saved presets yet"
          description="Save the current criteria to reuse them later."
        />
      ) : (
        <Stack gap="2">
          {visible.map((preset) => (
            <Card key={preset.id} padding="sm">
              <Flex gap="2" align="center" wrap>
                <strong>{preset.name}</strong>{" "}
                <span style={{ fontSize: "var(--font-size-body-sm)", color: "var(--color-text-muted)" }}>
                  ({Object.keys(preset.criteria).length} criteria)
                </span>
                {Object.entries(preset.criteria).slice(0, 3).map(([k, v]) => (
                  <Badge key={k} tone="neutral" size="xs">
                    {k}: {String(v)}
                  </Badge>
                ))}
                {Object.keys(preset.criteria).length > 3 && (
                  <Badge tone="neutral" size="xs">
                    +{Object.keys(preset.criteria).length - 3} more
                  </Badge>
                )}
              </Flex>
              <Flex gap="2">
                <Button type="button" variant="primary" size="sm" onClick={() => void handleLoad(preset)}>
                  Load
                </Button>{" "}
                <Button type="button" variant="secondary" size="sm" onClick={() => setConfirmDelete(preset)}>
                  Delete
                </Button>
              </Flex>
            </Card>
          ))}
        </Stack>
      )}
      <Flex gap="2" align="end">
        <FieldShell id="preset-manager-name" label="Preset name">
          <TextInput
            id="preset-manager-name"
            value={name}
            placeholder="e.g. RSI bounce"
            onChange={(event) => setName(event.target.value)}
          />
        </FieldShell>
        <Button
          type="button"
          variant="secondary"
          disabled={name.trim() === "" || saving}
          onClick={() => void handleSave()}
        >
          Save preset
        </Button>
      </Flex>
      <Modal
        open={confirmDelete !== null}
        onClose={() => setConfirmDelete(null)}
        title="Delete preset?"
        footer={
          <>
            <Button type="button" variant="danger" disabled={deleting} onClick={() => void handleDelete()}>
              Delete preset
            </Button>{" "}
            <Button type="button" variant="secondary" onClick={() => setConfirmDelete(null)}>
              Cancel
            </Button>
          </>
        }
      >
        <p>
          Delete &quot;{confirmDelete?.name}&quot;? This cannot be undone.
        </p>
      </Modal>
    </Card>
    </PageSection>
  );
}
