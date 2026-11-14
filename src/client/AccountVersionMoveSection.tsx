/**
 * Issue #3289 (sub-issue of #3241), slice 2 — the per-customer
 * version move + segment assignment section of the Accounts
 * panel, beside the unlimited-free grant section.
 *
 * For each live subscription the section shows the version
 * held and the current effective version for the account's
 * segment, with prices — and moves the subscription onto the
 * current version on operator confirmation. A move changes
 * the version, never the product; it never changes runs or
 * credits, and the current paid period runs to its end on
 * the old terms. The segment picker changes what the NEXT
 * per-run charge resolves to and what a future move may
 * target; it changes nothing about held versions.
 *
 * Both actions call the slice-1 primitives (the move route
 * and the set-segment route) and show the audit record the
 * route returns. The segment always derives from the
 * verified account row; a move never trusts a
 * client-supplied segment.
 */
import { useCallback, useEffect, useState } from "react";
import { Button, Notice, Select, Stack, TextInput } from "./components/ui";
import { apiFetch } from "./apiFetch";
import { DEFAULT_SEGMENT, resolveEffectiveVersion } from "../data/productPorts";
import { COMMERCIAL_API_BASE, commercialPath } from "../data/commercialUrlCatalog";
import type { AccountSubscriptionView } from "./AccountAdminPanel";
import type { PlanVersionView, ProductEntry } from "./ProductsSection";

async function readJson(res: Response): Promise<Record<string, unknown>> {
  return (await res.json().catch(() => ({}))) as Record<string, unknown>;
}

/**
 * apiFetch + JSON parse, throwing on a non-OK status with the
 * server's error message — so call sites handle failures in
 * try/catch instead of checking res.ok at every call.
 * (apiFetch itself returns the Response and never throws on
 * an HTTP error status.)
 */
async function apiJson<T = unknown>(path: string, init?: RequestInit): Promise<T> {
  const res = await apiFetch(path, init);
  const data = await readJson(res);
  if (!res.ok) {
    throw new Error((typeof data.error === "string" && data.error) || `Request failed (${res.status}).`);
  }
  return data as T;
}

export function AccountVersionMoveSection({
  userId,
  subscriptions,
}: {
  userId: string;
  subscriptions: AccountSubscriptionView[];
}) {
  const [segment, setSegment] = useState<string | null>(null);
  const [entries, setEntries] = useState<ProductEntry[] | null>(null);
  const [loading, setLoading] = useState(true);
  const [error, setError] = useState("");
  const [note, setNote] = useState("");
  const [segmentChoice, setSegmentChoice] = useState("");
  const [customSegment, setCustomSegment] = useState("");
  const [reason, setReason] = useState("");
  const [busy, setBusy] = useState(false);

  const load = useCallback(async () => {
    setLoading(true);
    setError("");
    try {
      const [accountBody, productsBody] = await Promise.all([
        apiJson<{ segment?: string }>(`${commercialPath("account")}?userId=${encodeURIComponent(userId)}`),
        apiJson<{ products: ProductEntry[] }>(commercialPath("products")),
      ]);
      setSegment(accountBody.segment ?? DEFAULT_SEGMENT);
      setEntries(productsBody.products ?? []);
    } catch (err: any) {
      setError(err.message || "Failed to load the account's version state.");
    } finally {
      setLoading(false);
    }
  }, [userId]);

  useEffect(() => {
    void load();
  }, [load]);

  const planVersions = new Map<string, PlanVersionView>();
  const knownSegments = new Set<string>();
  for (const { versions } of entries ?? []) {
    for (const version of versions) {
      knownSegments.add(version.segment);
      if ("periodDays" in version) planVersions.set(version.id, version);
    }
  }
  const segmentOptions = [DEFAULT_SEGMENT, ...[...knownSegments].filter((s) => s !== DEFAULT_SEGMENT).sort()];
  if (segment && !segmentOptions.includes(segment)) segmentOptions.push(segment);
  const effectiveSegmentChoice =
    segmentChoice === "__custom" ? customSegment.trim() : segmentChoice || segment || DEFAULT_SEGMENT;

  const nowMs = Date.now();
  const liveSubscriptions = subscriptions.filter((s) => s.status === "active" && s.periodEndMs > nowMs);

  const move = async (subscription: AccountSubscriptionView, toVersionId: string) => {
    setBusy(true);
    setError("");
    setNote("");
    try {
      const body = await apiJson<{ moved: boolean; fromVersionId: string; toVersionId: string }>(
        `${COMMERCIAL_API_BASE}/subscriptions/${encodeURIComponent(subscription.id)}/move`,
        { method: "POST", body: JSON.stringify({ toVersionId, reason: reason.trim() || null }) },
      );
      const from = planVersions.get(body.fromVersionId);
      const to = planVersions.get(body.toVersionId);
      setNote(
        body.moved
          ? `Moved ${userId} from ${from ? `v${from.version} ($${from.priceUSD.toFixed(2)})` : body.fromVersionId} to ${to ? `v${to.version} ($${to.priceUSD.toFixed(2)})` : body.toVersionId}. The move is recorded in the version-move audit.`
          : `Already on ${to ? `v${to.version}` : body.toVersionId} — no move was needed.`,
      );
      await load();
    } catch (err: any) {
      setError(err.message || "Failed to move the subscription.");
    } finally {
      setBusy(false);
    }
  };

  const changeSegment = async () => {
    if (!effectiveSegmentChoice) {
      setError("Choose a segment or enter one.");
      return;
    }
    setBusy(true);
    setError("");
    setNote("");
    try {
      const body = await apiJson<{ previousSegment: string; segment: string }>(
        `${COMMERCIAL_API_BASE}/accounts/${encodeURIComponent(userId)}/segment`,
        {
          method: "POST",
          body: JSON.stringify({ segment: effectiveSegmentChoice, reason: reason.trim() || null }),
        },
      );
      setNote(
        `Segment changed from "${body.previousSegment}" to "${body.segment}". Held versions are unchanged; the next per-run charge and any future move resolve against the new segment.`,
      );
      await load();
    } catch (err: any) {
      setError(err.message || "Failed to change the segment.");
    } finally {
      setBusy(false);
    }
  };

  return (
    <div data-testid="account-version-move-panel">
      <Stack gap="2">
        <div>
          <h3>Product versions</h3>
          <p>
            Move this customer to the current version of the product they hold, or change their segment. A move
            never changes runs or credits; the current paid period runs to its end on the old terms.
          </p>
        </div>
        {error && <Notice tone="danger">{error}</Notice>}
        {note && <Notice tone="success">{note}</Notice>}
        {loading && <p>Loading version state…</p>}
        {!loading && segment !== null && (
          <>
            <div>
              Current segment: <strong>{segment}</strong>
            </div>
            {liveSubscriptions.length === 0 && <p>No live subscriptions to move.</p>}
            {liveSubscriptions.map((subscription) => {
              const held = planVersions.get(subscription.planId);
              if (!held) {
                return (
                  <div key={subscription.id}>
                    Subscription {subscription.id}: held version {subscription.planId} is not a known plan version.
                  </div>
                );
              }
              const chain = [...planVersions.values()].filter(
                (v) => v.productId === held.productId && v.segment === segment,
              );
              const target = resolveEffectiveVersion(chain, segment, nowMs);
              const alreadyCurrent = target?.id === held.id;
              return (
                <div key={subscription.id} data-testid={`held-version-${subscription.id}`}>
                  <Stack gap="1">
                    <div>
                      {held.name}: held v{held.version} · ${held.priceUSD.toFixed(2)}
                      {target
                        ? ` — current for segment "${segment}": v${target.version} · $${target.priceUSD.toFixed(2)}`
                        : ` — no current version for segment "${segment}"`}
                    </div>
                    <div>
                      Period ends {new Date(subscription.periodEndMs).toLocaleString()}
                      {subscription.canceledAtMs ? " · canceled, riding to period end" : ""}
                    </div>
                    {target && !alreadyCurrent && (
                      <div>
                        <Button loading={busy} onClick={() => void move(subscription, target.id)}>
                          Move to v{target.version} (${target.priceUSD.toFixed(2)})
                        </Button>
                      </div>
                    )}
                    {target && alreadyCurrent && <div>Already on the current version for this segment.</div>}
                    {!target && (
                      <div>
                        No move is possible until an approved, effective version exists for this segment.
                      </div>
                    )}
                  </Stack>
                </div>
              );
            })}
            <Stack gap="1">
              <h4>Change segment</h4>
              <Select
                label="Segment"
                value={segmentChoice}
                onChange={(e) => setSegmentChoice(e.target.value)}
                hint="Free-form operator label. A segment changes what the next charge resolves to — never what is held."
              >
                <option value="">Keep the current segment</option>
                {segmentOptions.map((option) => (
                  <option key={option} value={option}>
                    {option}
                  </option>
                ))}
                <option value="__custom">Enter a different segment…</option>
              </Select>
              {segmentChoice === "__custom" && (
                <TextInput label="Custom segment" value={customSegment} onChange={(e) => setCustomSegment(e.target.value)} />
              )}
              <TextInput
                label="Reason (optional)"
                value={reason}
                onChange={(e) => setReason(e.target.value)}
                hint="Recorded on the move/segment audit row when given."
              />
              <div>
                <Button loading={busy} disabled={!segmentChoice} onClick={() => void changeSegment()}>
                  Change segment
                </Button>
              </div>
            </Stack>
          </>
        )}
      </Stack>
    </div>
  );
}
