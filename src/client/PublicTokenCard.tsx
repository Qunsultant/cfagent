import React, { useCallback, useEffect, useState } from "react";
import { Button, Card, Flex, Notice, Spinner, Stack, TextInput, useToast } from "./components/ui";
import { apiFetch, csrfHeaders } from "./apiFetch";
import { connectStatusEndpoint, tokenConnectEndpoint, tokenDisconnectEndpoint } from "./brokerEndpoints";

/**
 * Issue #3990 — Public.com personal access token card.
 *
 * The Public connect surface, mirroring the Alpaca sign-in card's
 * honesty rules (#3351): the token is verified against Public's MCP
 * server (tools/list) BEFORE it is stored (POST /api/public/connect
 * does that server-side), the status read is the neutral connect
 * read (GET /api/broker/connect/public), and the token is cleared
 * from component state the moment the request settles, so it cannot
 * survive in a re-render, a toast, or a console dump. The status
 * shows only a 4+4 hint, never the token.
 *
 * Public has no paper trading: the card says so, so a user in TEST
 * mode is not led to expect paper fills.
 *
 * Styling: `ui/` primitives and tokens only — no inline styles.
 */

interface TokenStatus {
  broker: string;
  configured: boolean;
  signedIn: boolean;
  method: "oauth" | "personal" | null;
  tokenHint: string | null;
  /** #4035: when the credential was verified, and what it saw. */
  verifiedAt?: string | null;
  toolCount?: number;
}

type LoadState =
  | { state: "loading" }
  | { state: "ready"; status: TokenStatus }
  | { state: "error"; message: string };

export function PublicTokenCard() {
  let toast: ReturnType<typeof useToast> | null = null;
  try {
    toast = useToast();
  } catch {
    // Optional in test harnesses without ToastProvider
  }
  const [load, setLoad] = useState<LoadState>({ state: "loading" });
  const [token, setToken] = useState("");
  const [submitting, setSubmitting] = useState(false);
  const [formError, setFormError] = useState<string | null>(null);

  const refresh = useCallback(async () => {
    const url = connectStatusEndpoint("public");
    if (!url) {
      setLoad({ state: "error", message: "No connect surface is configured for Public.com." });
      return;
    }
    setLoad({ state: "loading" });
    try {
      const res = await apiFetch(url);
      if (!res.ok) {
        setLoad({ state: "error", message: "Public.com could not be reached. Check your connection and try again." });
        return;
      }
      const body = (await res.json()) as TokenStatus;
      setLoad({ state: "ready", status: body });
    } catch {
      setLoad({ state: "error", message: "Public.com could not be reached. Check your connection and try again." });
    }
  }, []);

  useEffect(() => {
    void refresh();
  }, [refresh]);

  const handleConnect = async () => {
    const value = token.trim();
    if (!value) {
      setFormError("Paste your Public.com personal access token.");
      return;
    }
    const url = tokenConnectEndpoint("public");
    if (!url) {
      setFormError("No connect endpoint is configured for Public.com.");
      return;
    }
    setFormError(null);
    setSubmitting(true);
    try {
      const res = await apiFetch(url, {
        method: "POST",
        headers: { "Content-Type": "application/json", ...csrfHeaders() },
        body: JSON.stringify({ token: value }),
      });
      const body = (await res.json().catch(() => null)) as { error?: string; toolCount?: number } | null;
      if (!res.ok) {
        setFormError(body?.error ?? "Public.com rejected that token.");
        return;
      }
      toast?.success(`Public.com connected (${body?.toolCount ?? "?"} tools verified).`);
      await refresh();
    } catch {
      setFormError("Public.com could not be reached. Check your connection and try again.");
    } finally {
      setToken("");
      setSubmitting(false);
    }
  };

  const handleDisconnect = async () => {
    const url = tokenDisconnectEndpoint("public");
    if (!url) return;
    setSubmitting(true);
    try {
      await apiFetch(url, { method: "POST", headers: { ...csrfHeaders() } });
      toast?.success("Public.com disconnected.");
      await refresh();
    } catch {
      setFormError("Disconnect failed. Try again.");
    } finally {
      setSubmitting(false);
    }
  };

  return (
    <Card>
      <h4>Public.com personal access token</h4>
      <Stack gap="2">
        <Notice tone="info">
          Public.com has no paper trading mode: in TEST mode you can preview orders and read data, and placement is
          refused. Orders place only in live mode, with real money.
        </Notice>
        {load.state === "loading" && <Spinner size="sm" />}
        {load.state === "error" && <Notice tone="danger">{load.message}</Notice>}
        {load.state === "ready" && (
          <p>
            {load.status.configured
              ? `Connected (${load.status.method ?? "personal"}${load.status.tokenHint ? `, ${load.status.tokenHint}` : ""})${
                  load.status.verifiedAt
                    ? ` \u00b7 verified ${new Date(load.status.verifiedAt).toLocaleString()} \u00b7 ${load.status.toolCount ?? 0} tools`
                    : ""
                }.`
              : "Not connected."}
          </p>
        )}
        {load.state === "ready" &&
          load.status.configured &&
          (load.status.toolCount ?? 0) === 0 && (
            <Notice tone="warning">
              Connected, but the last verification observed no tools. Reconnect, and if it persists the
              token lacks the data scopes this app needs.
            </Notice>
          )}
        {formError && <Notice tone="danger">{formError}</Notice>}
        <TextInput
          type="password"
          aria-label="Public.com personal access token"
          value={token}
          onChange={(e) => setToken(e.target.value)}
          placeholder="Paste your Public.com personal access token"
          autoComplete="off"
        />
        <Flex align="center" gap="2">
          <Button type="button" size="sm" onClick={handleConnect} disabled={submitting} loading={submitting}>
            {load.state === "ready" && load.status.configured ? "Replace token" : "Connect Public.com"}
          </Button>
          {load.state === "ready" && load.status.configured && (
            <Button type="button" size="sm" variant="secondary" onClick={handleDisconnect} disabled={submitting}>
              Disconnect
            </Button>
          )}
        </Flex>
        <p>
          Create the token on the API settings page of your Public account. It is verified against Public&apos;s MCP
          server before it is stored, and never shown again.
        </p>
      </Stack>
    </Card>
  );
}
