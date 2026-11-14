/**
 * Issue #3315 (sub-issue of #3241) — free-run allowance section
 * for the Platform Admin page (Platform Admin -> Free Runs).
 *
 * Operator-only: view and change the platform-wide free-run
 * allowance per product (family: stock, goal, options,
 * strategy), in runs per UTC calendar month. The allowance is
 * platform-wide, not per account — one row per family in
 * agent_free_run_allowances — and the gate reads the store
 * only: a family with no stored row reads as null and gets no
 * free runs (fail-closed). The section therefore shows "Not
 * set" honestly instead of inventing a value, and the operator
 * sets an explicit non-negative whole number (0 disables free
 * runs for that product).
 *
 * Reads and writes through the operator-gated allowance
 * routes (GET + POST /payments/agentic/commercial/free-run-
 * allowance); it invents no new path and no second allowance
 * source. A 403 from those routes means the server refused,
 * never a client bug. No allowance value is hardcoded here:
 * the seed lives only as migration 0044's rows.
 *
 * Built strictly with src/client/components/ui/ primitives and
 * token-only styling per docs/agents/ux-architecture.md §20.
 * All calls go through src/client/apiFetch.ts (the #71 rule).
 */
import { useCallback, useEffect, useState } from "react";
import { Button, Notice, Stack, TextInput } from "./components/ui";
import { apiFetch } from "./apiFetch";
import { FREE_RUN_FAMILIES } from "../data/freeRunCounterPorts";

import { commercialPath } from "../data/commercialUrlCatalog";
export interface FreeRunAllowanceEntry {
  family: string;
  runs: number | null;
}

/** Display labels, same words as the price catalogue's family list. */
const FAMILY_LABELS: Record<string, string> = {
  stock: "Stock",
  goal: "Goal",
  options: "Options",
  strategy: "Strategy",
};

function labelFor(family: string): string {
  return FAMILY_LABELS[family] ?? family;
}

function isAllowanceList(value: unknown): value is FreeRunAllowanceEntry[] {
  if (!Array.isArray(value)) return false;
  return value.every((entry) => {
    if (typeof entry !== "object" || entry === null) return false;
    const row = entry as Record<string, unknown>;
    return (
      typeof row.family === "string" &&
      (row.runs === null || typeof row.runs === "number")
    );
  });
}

async function readJson(res: Response): Promise<Record<string, unknown>> {
  return (await res.json().catch(() => ({}))) as Record<string, unknown>;
}

function allowanceStatus(runs: number | null): string {
  if (runs === null) return "Not set — no free runs for this product.";
  if (runs === 0) return "0 runs per month — free runs disabled for this product.";
  return `${runs} runs per month.`;
}

export function FreeRunAllowanceSection() {
  const [allowances, setAllowances] = useState<FreeRunAllowanceEntry[] | null>(null);
  const [drafts, setDrafts] = useState<Record<string, string>>({});
  const [loading, setLoading] = useState(true);
  const [error, setError] = useState("");
  const [saving, setSaving] = useState<string | null>(null);
  const [note, setNote] = useState("");

  const load = useCallback(async () => {
    setLoading(true);
    setError("");
    try {
      const res = await apiFetch(commercialPath("freeRunAllowance"));
      const data = await readJson(res);
      if (!res.ok) {
        setError(
          res.status === 403
            ? "Operator access required: only store operators may manage the free-run allowance."
            : (data.error as string) || "Could not load the free-run allowances.",
        );
        setAllowances(null);
        return;
      }
      if (!isAllowanceList(data.allowances)) {
        setError("Unexpected allowance response from the server.");
        setAllowances(null);
        return;
      }
      setAllowances(data.allowances);
      setDrafts(Object.fromEntries(data.allowances.map((row) => [row.family, row.runs === null ? "" : String(row.runs)])));
    } catch {
      setError("Could not load the free-run allowances.");
      setAllowances(null);
    } finally {
      setLoading(false);
    }
  }, []);

  useEffect(() => {
    void load();
  }, [load]);

  const saveFamily = useCallback(
    async (family: string) => {
      const raw = (drafts[family] ?? "").trim();
      const parsed = Number(raw);
      if (raw === "" || !Number.isInteger(parsed) || parsed < 0) {
        setNote(`Enter a non-negative whole number of runs for ${labelFor(family)}.`);
        return;
      }
      setSaving(family);
      setNote("");
      try {
        const res = await apiFetch(commercialPath("freeRunAllowance"), {
          method: "POST",
          headers: { "Content-Type": "application/json" },
          body: JSON.stringify({ family, runs: parsed }),
        });
        const data = await readJson(res);
        if (!res.ok) {
          setNote((data.error as string) || "Allowance update failed.");
          return;
        }
        setNote(`Free-run allowance for ${labelFor(family)} set to ${parsed} runs per month.`);
        await load();
      } catch {
        setNote("Allowance update failed.");
      } finally {
        setSaving(null);
      }
    },
    [drafts, load],
  );

  if (loading) return null;
  if (error) return <Notice tone="danger">{error}</Notice>;
  if (!allowances) return null;

  return (
    <Stack gap="1" data-testid="free-runs-panel">
      <h4>Free-run allowance (operator)</h4>
      <p>
        How many free runs each product gets per calendar month, platform-wide. A Free-tier account may
        run up to the allowance without payment; at the cap the gate falls through to the paid path.
        A product with no allowance set gets no free runs. Changes apply to the next gate check —
        runs already consumed this month are not re-counted.
      </p>
      {FREE_RUN_FAMILIES.map((family) => {
        const row = allowances.find((entry) => entry.family === family);
        const runs = row?.runs ?? null;
        return (
          <div key={family}>
            <div>
              <strong>{labelFor(family)}:</strong> {allowanceStatus(runs)}
            </div>
            <TextInput
              label={`${labelFor(family)} allowance (runs per month)`}
              value={drafts[family] ?? ""}
              onChange={(event) => setDrafts((prev) => ({ ...prev, [family]: event.target.value }))}
            />
            <div>
              <Button onClick={() => void saveFamily(family)} loading={saving === family}>
                Save {labelFor(family)} allowance
              </Button>
            </div>
          </div>
        );
      })}
      {note && <Notice tone="info">{note}</Notice>}
    </Stack>
  );
}
