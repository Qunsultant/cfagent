import React, { useCallback, useEffect, useRef, useState } from "react";
import { Badge, Button, Card, Flex, Notice, Spinner, Stack, TextInput, useToast } from "./components/ui";
import { csrfHeaders } from "./apiFetch";
import { useBrokerEnvironment } from "./brokerEnvironment";

/**
 * Issue #3351 — Alpaca sign-in.
 *
 * Why this exists: "Connect Alpaca" used to verify the *deployment's* secrets and
 * report the result to whoever clicked, so a user was told they were connected
 * to an account that was not theirs. This card is the real thing: the user's own
 * key pair, verified against the trading type the platform will actually use,
 * stored per user, and revocable. The secret is entered here and never read back
 * — after a successful sign-in the card shows the trading type, the key id's
 * last four characters and where the credential came from.
 *
 * Honesty rules (inherited from the broker panel contract, #2853):
 *   - the THREE facts are separate: something is configured, *you* signed in, and
 *     which source served the read. A deployment key is not a user sign-in;
 *   - a failure states its outcome code and what to fix, never an upstream body;
 *   - the secret is cleared from component state the moment the request settles,
 *     so it cannot survive in a re-render, a toast, or a console dump.
 *
 * Styling: `ui/` primitives and tokens only — no inline styles (#3047 budget).
 */

interface ConnectStatus {
  side: "paper" | "live";
  configured: boolean;
  signedIn: boolean;
  source: "user" | "deployment" | "none";
  keyIdLast4: string | null;
  storedAt: string | null;
}

type LoadState =
  | { state: "loading" }
  | { state: "ready"; status: ConnectStatus }
  | { state: "error"; code: string | null; message: string };

function failure(body: unknown): { code: string | null; message: string } {
  const record = (body ?? {}) as Record<string, unknown>;
  return {
    code: typeof record.code === "string" ? record.code : null,
    message:
      typeof record.message === "string"
        ? record.message
        : "Alpaca could not be reached. Check your connection and try again.",
  };
}

function sideLabel(side: "paper" | "live"): string {
  return side === "live" ? "live trading" : "paper trading";
}

export interface AlpacaSignInCardProps {
  /** Passed by the panel for parity; the server resolves the trading type. */
  activeEnv?: string;
  /** When true and deployment keys are active, collapses the sign-in form so pages don't re-ask for credentials. */
  collapsedWhenConfigured?: boolean;
}

export function AlpacaSignInCard({ activeEnv, collapsedWhenConfigured = false }: AlpacaSignInCardProps) {
  let toast: ReturnType<typeof useToast> | null = null;
  try {
    toast = useToast();
  } catch {
    // Optional in test harnesses without ToastProvider
  }
  const brokerEnv = useBrokerEnvironment();
  const effectiveEnv = activeEnv ?? brokerEnv;
  const [load, setLoad] = useState<LoadState>({ state: "loading" });
  const [apiKey, setApiKey] = useState("");
  const [secretKey, setSecretKey] = useState("");
  const [submitting, setSubmitting] = useState(false);
  const [formError, setFormError] = useState<string | null>(null);
  const [showCustomForm, setShowCustomForm] = useState(false);
  const notifiedRef = useRef(false);

  useEffect(() => {
    if (load.state === "ready" && !load.status.configured && !load.status.signedIn && !notifiedRef.current) {
      notifiedRef.current = true;
      toast?.warning(
        `Sign in required for ${load.status.side === "live" ? "live" : "paper"} trading. Enter your Alpaca API keys.`,
        "Alpaca Sign-in Required",
      );
    }
  }, [load]);

  const readStatus = useCallback(async () => {
    try {
      const url = `/api/broker/connect/alpaca?environment=${encodeURIComponent(effectiveEnv)}`;
      const res = await fetch(url, { headers: { Accept: "application/json" } });
      const body = await res.json().catch(() => ({}));
      if (!res.ok) {
        const detail = failure(body);
        setLoad({ state: "error", code: detail.code, message: detail.message });
        return;
      }
      setLoad({ state: "ready", status: body as ConnectStatus });
    } catch {
      setLoad({
        state: "error",
        code: null,
        message: "Alpaca could not be reached. Check your connection and try again.",
      });
    }
  }, [effectiveEnv]);

  useEffect(() => {
    void readStatus();
  }, [readStatus]);

  const signIn = async (event: React.FormEvent) => {
    event.preventDefault();
    setFormError(null);
    setSubmitting(true);
    try {
      const url = `/api/broker/connect/alpaca?environment=${encodeURIComponent(effectiveEnv)}`;
      const res = await fetch(url, {
        method: "POST",
        headers: {
          "Content-Type": "application/json",
          Accept: "application/json",
          ...csrfHeaders(),
        },
        body: JSON.stringify({ apiKey, secretKey, environment: effectiveEnv }),
      });
      const body = await res.json().catch(() => ({}));
      if (!res.ok) {
        const detail = failure(body);
        setFormError(detail.code ? `${detail.message} (${detail.code})` : detail.message);
        return;
      }
      setLoad({ state: "ready", status: body as ConnectStatus });
    } catch {
      setFormError("Alpaca could not be reached. Check your connection and try again.");
    } finally {
      // The secret never outlives the request that used it.
      setSecretKey("");
      setSubmitting(false);
    }
  };

  const signOut = async () => {
    setFormError(null);
    setSubmitting(true);
    try {
      const url = `/api/broker/disconnect/alpaca?environment=${encodeURIComponent(effectiveEnv)}`;
      const res = await fetch(url, {
        method: "POST",
        headers: {
          Accept: "application/json",
          ...csrfHeaders(),
        },
      });
      const body = await res.json().catch(() => ({}));
      if (!res.ok) {
        const detail = failure(body);
        setFormError(detail.code ? `${detail.message} (${detail.code})` : detail.message);
        return;
      }
      setLoad({ state: "ready", status: body as ConnectStatus });
    } catch {
      setFormError("Alpaca could not be reached. Check your connection and try again.");
    } finally {
      setSubmitting(false);
    }
  };

  if (load.state === "loading") {
    return (
      <Card>
        <Flex align="center" gap="2">
          <h4>Alpaca sign-in</h4>
          <Spinner size="sm" label="Loading Alpaca sign-in status" />
        </Flex>
      </Card>
    );
  }

  if (load.state === "error") {
    return (
      <Card>
        <h4>Alpaca sign-in</h4>
        <Notice tone="danger" title="Alpaca sign-in is unavailable">
          <span data-broker-code={load.code ?? "unavailable"}>{load.message}</span>
          {load.code && <span> ({load.code})</span>}
        </Notice>
        <Button type="button" variant="secondary" size="sm" onClick={() => void readStatus()}>
          Try again
        </Button>
      </Card>
    );
  }

  const status = load.status;

  return (
    <Card data-alpaca-signin="1" data-active-env={effectiveEnv}>
      <Flex align="center" gap="2">
        <h4>Alpaca sign-in</h4>
        <Badge tone={status.signedIn ? "success" : status.configured ? "neutral" : "warning"} size="sm">
          {status.signedIn ? "Signed in" : status.configured ? "Deployment keys" : "Not connected"}
        </Badge>
        <Badge tone={status.side === "live" ? "warning" : "info"} size="sm">
          {status.side === "live" ? "Live trading" : "Paper trading"}
        </Badge>
      </Flex>

      {status.signedIn ? (
        <Stack gap="2">
          <p data-alpaca-signin-source="user">
            Signed in for {sideLabel(status.side)} as key <code>••••{status.keyIdLast4}</code>. The secret is
            never shown again; sign out and sign in again to replace it.
          </p>
          <Button
            type="button"
            variant="secondary"
            size="sm"
            disabled={submitting}
            loading={submitting}
            onClick={() => void signOut()}
          >
            Sign out of Alpaca
          </Button>
        </Stack>
      ) : collapsedWhenConfigured && status.configured && !showCustomForm ? (
        <Stack gap="2">
          <p data-alpaca-signin-source={status.source}>
            The deployment's Alpaca keys are serving this account. Sign in with your own key pair to trade your own Alpaca account.
          </p>
          <div>
            <Button
              type="button"
              variant="secondary"
              size="sm"
              onClick={() => setShowCustomForm(true)}
            >
              Sign in with your own key pair
            </Button>
          </div>
        </Stack>
      ) : (
        <Stack gap="2">
          <p data-alpaca-signin-source={status.source}>
            {status.configured
              ? "The deployment's Alpaca keys are serving this account. Sign in with your own key pair to trade your own Alpaca account."
              : "Sign in with your Alpaca key pair to trade your own Alpaca account."}
          </p>
          <form onSubmit={(event) => void signIn(event)}>
            <Stack gap="2">
              <TextInput
                label="Alpaca API key id"
                hint={`Use the ${status.side === "live" ? "live" : "paper"} key for this environment.`}
                autoComplete="off"
                spellCheck={false}
                value={apiKey}
                onChange={(event) => setApiKey(event.target.value)}
                data-alpaca-signin-field="apiKey"
              />
              <TextInput
                label="Alpaca API secret"
                type="password"
                autoComplete="off"
                spellCheck={false}
                value={secretKey}
                onChange={(event) => setSecretKey(event.target.value)}
                data-alpaca-signin-field="secretKey"
              />
              <Flex align="center" gap="2">
                <Button type="submit" size="sm" disabled={submitting} loading={submitting}>
                  Sign in to Alpaca
                </Button>
                {status.configured && (
                  <Button type="button" variant="secondary" size="sm" onClick={() => setShowCustomForm(false)}>
                    Cancel
                  </Button>
                )}
                <span className="ui-field-msg">
                  Verified against Alpaca for {sideLabel(status.side)} before anything is stored.
                </span>
              </Flex>
            </Stack>
          </form>
        </Stack>
      )}

      {formError && (
        <Notice tone="danger" title="Alpaca sign-in did not complete">
          <span data-alpaca-signin-error="1">{formError}</span>
        </Notice>
      )}
    </Card>
  );
}
