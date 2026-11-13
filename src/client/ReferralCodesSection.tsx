/**
 * Issue #3307 (sub-issue of #3241), slice 2 — referral codes
 * on the billing tab.
 *
 * One section rendering the code-runs balance (kept visibly
 * separate from the USD referral-credit balance — runs vs USD,
 * never one number), a redeem form, the caller's own referral
 * codes, and a per-family "Get my referral code" action. It
 * CALLS existing routes only (R6 redeem, R7/R9 own codes,
 * R8 self-service issue, R10 balance) and creates none. The
 * plaintext of a minted code is shown ONCE, in the issuing
 * session, and never stored client-side.
 *
 * Rule availability has no user-readable read: the section
 * shows the mint action per family and hides a family's action
 * when its mint answers 409 (no active user-issuer rule for
 * that product). Once every family has answered 409 in-session
 * and the caller holds no codes, the mint block renders
 * nothing — no dead affordance. ui primitives only, token-only
 * styling.
 */
import React, { useCallback, useEffect, useState } from "react";
import { Button } from "./components/ui/Button";
import { Card } from "./components/ui/Card";
import { Notice } from "./components/ui/Notice";
import { TextInput } from "./components/ui/TextInput";
import { apiFetch } from "./apiFetch";
import { fetchPlatformIdentity } from "./firstRunApi";
import { codedMessage } from "../outcomes/outcomeAspects";
import { PRICE_FAMILIES, type PriceFamily } from "../data/priceCataloguePorts";
import { perRunProductId } from "../data/productPorts";

const REFERRAL_CODE_BASE = "/api/payments/agentic/commercial";

interface PublicReferralCodeView {
  id: string;
  displayPrefix: string;
  ruleId: string;
  productId: string;
  kind: string;
  issuerLogin: string;
  issuerKind: string;
  referrerUserId: string | null;
  tenantScope: string | null;
  runs: number;
  reusable: boolean;
  expiresAtMs: number | null;
  revokedAtMs: number | null;
  redemptionCount: number;
  createdAtMs: number;
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}

function isPublicReferralCodeView(value: unknown): value is PublicReferralCodeView {
  if (!isRecord(value)) return false;
  return (
    typeof value.id === "string" &&
    typeof value.displayPrefix === "string" &&
    typeof value.productId === "string" &&
    typeof value.kind === "string" &&
    typeof value.issuerLogin === "string" &&
    typeof value.issuerKind === "string" &&
    typeof value.runs === "number" &&
    typeof value.reusable === "boolean" &&
    (value.expiresAtMs === null || typeof value.expiresAtMs === "number") &&
    (value.revokedAtMs === null || typeof value.revokedAtMs === "number") &&
    typeof value.redemptionCount === "number"
  );
}

function day(ms: number): string {
  return new Date(ms).toISOString().slice(0, 10);
}

async function readJson(res: Response): Promise<Record<string, unknown>> {
  try {
    const data = (await res.json()) as unknown;
    return isRecord(data) ? data : {};
  } catch {
    return {};
  }
}

async function getJson<T>(path: string): Promise<T> {
  const res = await apiFetch(path);
  const data = await readJson(res);
  if (!res.ok) {
    const code = typeof data.code === "string" ? data.code : null;
    throw new Error(code ? codedMessage(code) : `Request failed (${res.status}).`);
  }
  return data as T;
}

async function postJson<T>(path: string, body: unknown): Promise<T> {
  const res = await apiFetch(path, { method: "POST", body: JSON.stringify(body) });
  const data = await readJson(res);
  if (!res.ok) {
    const code = typeof data.code === "string" ? data.code : null;
    throw new Error(code ? codedMessage(code) : `Request failed (${res.status}).`);
  }
  return data as T;
}

export function ReferralCodesSection() {
  const [login, setLogin] = useState<string | null>(null);
  const [balance, setBalance] = useState<number | null>(null);
  const [balanceError, setBalanceError] = useState(false);
  const [ownCodes, setOwnCodes] = useState<PublicReferralCodeView[] | null>(null);
  const [loading, setLoading] = useState(true);
  const [loadError, setLoadError] = useState<string | null>(null);
  const [redeemInput, setRedeemInput] = useState("");
  const [redeeming, setRedeeming] = useState(false);
  const [redeemNote, setRedeemNote] = useState<string | null>(null);
  const [redeemError, setRedeemError] = useState<string | null>(null);
  const [issued, setIssued] = useState<Record<string, { plaintext: string; runs: number }>>({});
  const [unavailableFamilies, setUnavailableFamilies] = useState<string[]>([]);
  const [mintingFamily, setMintingFamily] = useState<string | null>(null);
  const [mintError, setMintError] = useState<string | null>(null);
  const [revokingId, setRevokingId] = useState<string | null>(null);

  const loadOwnCodes = useCallback(async () => {
    const body = await getJson<{ codes: unknown }>(`${REFERRAL_CODE_BASE}/referral-codes/mine`);
    const rows = Array.isArray(body.codes) ? body.codes.filter(isPublicReferralCodeView) : [];
    setOwnCodes(rows);
  }, []);

  const loadBalance = useCallback(
    async (userLogin: string) => {
      const body = await getJson<{ codeRunsAvailable: unknown }>(
        `${REFERRAL_CODE_BASE}/referral-codes/balance?userId=${encodeURIComponent(userLogin)}`,
      );
      if (typeof body.codeRunsAvailable !== "number") throw new Error("bad balance");
      setBalance(body.codeRunsAvailable);
    },
    [],
  );

  const load = useCallback(async () => {
    setLoading(true);
    setLoadError(null);
    setBalanceError(false);
    try {
      const identity = await fetchPlatformIdentity();
      setLogin(identity.userLogin);
      const [balanceResult, codesResult] = await Promise.allSettled([
        loadBalance(identity.userLogin),
        loadOwnCodes(),
      ]);
      if (balanceResult.status === "rejected") setBalanceError(true);
      if (codesResult.status === "rejected") setOwnCodes([]);
    } catch {
      setLoadError("Your referral codes could not be loaded. Try again later.");
    } finally {
      setLoading(false);
    }
  }, [loadBalance, loadOwnCodes]);

  useEffect(() => {
    void load();
  }, [load]);

  const redeem = async () => {
    const code = redeemInput.trim();
    if (!code) {
      setRedeemError("Enter a code to redeem it.");
      return;
    }
    setRedeeming(true);
    setRedeemNote(null);
    setRedeemError(null);
    try {
      const body = await postJson<{
        runsGranted: unknown;
        codeRunsBalance: unknown;
        replayed: unknown;
      }>(`${REFERRAL_CODE_BASE}/referral-codes/redeem`, { code });
      const runsGranted = typeof body.runsGranted === "number" ? body.runsGranted : 0;
      const nextBalance = typeof body.codeRunsBalance === "number" ? body.codeRunsBalance : null;
      if (nextBalance !== null) setBalance(nextBalance);
      setRedeemInput("");
      setRedeemNote(
        body.replayed === true
          ? `That code was already redeemed — no runs were added again. You have ${nextBalance ?? "?"} code runs.`
          : `${runsGranted} free runs added. You now have ${nextBalance ?? "?"} code runs.`,
      );
    } catch (err: any) {
      setRedeemError(err.message || "That code could not be redeemed. Try again later.");
    } finally {
      setRedeeming(false);
    }
  };

  const mint = async (family: PriceFamily) => {
    setMintingFamily(family);
    setMintError(null);
    try {
      const body = await postJson<{ code: unknown; plaintext: string }>(
        `${REFERRAL_CODE_BASE}/referral-codes/mine`,
        { productId: perRunProductId(family) },
      );
      if (typeof body.plaintext !== "string" || !body.plaintext) {
        throw new Error("The issue route did not return a code value.");
      }
      const runs = isPublicReferralCodeView(body.code) ? body.code.runs : 0;
      setIssued((prev) => ({ ...prev, [family]: { plaintext: body.plaintext, runs } }));
      await loadOwnCodes();
    } catch (err: any) {
      // No active user-issuer rule for this product: hide this
      // family's action for the session instead of leaving a dead
      // button. Any other failure renders its fixed message.
      if (err.message === codedMessage("FAILURE_REFERRAL_CODE_RULE_UNAVAILABLE")) {
        setUnavailableFamilies((prev) => (prev.includes(family) ? prev : [...prev, family]));
      } else {
        setMintError(err.message || "Your referral code could not be issued. Try again later.");
      }
    } finally {
      setMintingFamily(null);
    }
  };

  const revokeOwn = async (codeId: string) => {
    setRevokingId(codeId);
    try {
      await postJson(`${REFERRAL_CODE_BASE}/referral-codes/mine/revoke`, { codeId });
      await loadOwnCodes();
    } catch {
      // A failed revoke leaves the list as-is; the next load
      // re-reads server truth.
    } finally {
      setRevokingId(null);
    }
  };

  // The mint block renders nothing once every family has answered
  // 409 (no active user rule anywhere) and the caller holds no
  // codes — no dead affordance. The balance + redeem form above
  // it always render: a balance can exist after rules deactivate.
  const showMintBlock =
    ownCodes !== null &&
    (ownCodes.length > 0 ||
      Object.keys(issued).length > 0 ||
      PRICE_FAMILIES.some((family) => !unavailableFamilies.includes(family)));

  return (
    <Card>
      <h3>Referral codes</h3>
      {loading && <p>Loading referral codes…</p>}
      {loadError && (
        <>
          <Notice tone="danger">{loadError}</Notice>
          <Button onClick={() => void load()}>Retry</Button>
        </>
      )}
      {!loading && !loadError && login !== null && (
        <>
          {balanceError ? (
            <p>Your code-runs balance could not be loaded.</p>
          ) : (
            <p>Code runs available: {balance ?? 0}</p>
          )}
          <p>
            Code runs are separate from your referral-credit balance above: they are free runs credited by
            a referral code, never dollars, and they spend after your free allowance.
          </p>
          <TextInput
            label="Redeem a code"
            value={redeemInput}
            onChange={(e) => setRedeemInput(e.target.value)}
          />
          <Button loading={redeeming} onClick={() => void redeem()}>
            Redeem code
          </Button>
          {redeemNote && <Notice tone="info">{redeemNote}</Notice>}
          {redeemError && <Notice tone="danger">{redeemError}</Notice>}
          {showMintBlock && (
            <>
              <h4>My referral code</h4>
              <p>
                Anyone who redeems your code gets free runs. A code is shown once, when it is issued — copy
                it now.
              </p>
              {mintError && <Notice tone="danger">{mintError}</Notice>}
              {PRICE_FAMILIES.map((family) => {
                const minted = issued[family];
                if (minted) {
                  return (
                    <div key={family}>
                      <p>
                        Your {family} referral code: {minted.plaintext} — anyone who redeems it gets{" "}
                        {minted.runs} free runs. Copy it now; it is never shown again.
                      </p>
                    </div>
                  );
                }
                if (unavailableFamilies.includes(family)) return null;
                return (
                  <div key={family}>
                    <Button
                      loading={mintingFamily === family}
                      onClick={() => void mint(family)}
                    >
                      Get my referral code ({family})
                    </Button>
                  </div>
                );
              })}
              {ownCodes !== null && ownCodes.length > 0 && (
                <>
                  <h4>My codes</h4>
                  {ownCodes.map((code) => (
                    <div key={code.id}>
                      <div>
                        <strong>{code.displayPrefix}</strong> · {code.kind} · {code.runs} runs ·{" "}
                        {code.reusable ? "reusable" : "one-time"} ·{" "}
                        {code.expiresAtMs === null ? "no expiry" : `expires ${day(code.expiresAtMs)}`} ·{" "}
                        {code.redemptionCount} redemptions
                      </div>
                      {code.revokedAtMs !== null ? (
                        <div>Revoked {day(code.revokedAtMs)}.</div>
                      ) : (
                        <Button
                          size="sm"
                          variant="secondary"
                          loading={revokingId === code.id}
                          onClick={() => void revokeOwn(code.id)}
                        >
                          Revoke
                        </Button>
                      )}
                    </div>
                  ))}
                </>
              )}
            </>
          )}
        </>
      )}
    </Card>
  );
}
