/**
 * API Keys settings section (issue #180).
 *
 * The management surface for the per-user API keys that authenticate
 * external MCP clients to /mcp. Before #180 the MCP transport trusted a
 * caller-asserted `x-user-id` header (anyone could impersonate anyone);
 * now external clients present one of these keys as a Bearer credential
 * and act as the user who minted it.
 *
 * The plaintext secret is shown EXACTLY ONCE, in the mint result below —
 * the server stores only its SHA-256 hash, so a key that is lost cannot
 * be recovered, only revoked and replaced. The one-time display says so,
 * next to the secret, not in a footnote.
 *
 * All calls go through src/client/apiFetch.ts (the #71 rule — the worker
 * may answer with a 202 async-job stub that only apiFetch resolves).
 */

import { useCallback, useEffect, useState } from "react";
import { Button, EmptyState, Notice, Spinner, TextInput } from "./components/ui";
import {
  fetchApiKeys,
  fmtApiKeyTime,
  mintApiKey,
  revokeApiKey,
  type ApiKeyInfo,
} from "./apiKeysApi";
import "./apiKeysPanel.css";

export function ApiKeysPanel() {
  const [keys, setKeys] = useState<ApiKeyInfo[]>([]);
  const [loading, setLoading] = useState(true);
  const [error, setError] = useState("");
  const [label, setLabel] = useState("");
  const [minting, setMinting] = useState(false);
  /** The one-time plaintext secret from the most recent mint. */
  const [freshSecret, setFreshSecret] = useState<string | null>(null);
  const [copied, setCopied] = useState(false);
  const [confirmingRevokeId, setConfirmingRevokeId] = useState<string | null>(null);
  const [revokingId, setRevokingId] = useState<string | null>(null);

  const load = useCallback(async () => {
    setLoading(true);
    setError("");
    try {
      setKeys(await fetchApiKeys());
    } catch (err: any) {
      setError(err?.message || "Failed to load API keys.");
      setKeys([]);
    } finally {
      setLoading(false);
    }
  }, []);

  useEffect(() => {
    void load();
  }, [load]);

  const handleMint = async () => {
    setMinting(true);
    setError("");
    setCopied(false);
    try {
      const { secret } = await mintApiKey(label.trim());
      setFreshSecret(secret);
      setLabel("");
      await load();
    } catch (err: any) {
      setError(err?.message || "Failed to create API key.");
    } finally {
      setMinting(false);
    }
  };

  const handleCopy = async () => {
    if (!freshSecret) return;
    try {
      await navigator.clipboard.writeText(freshSecret);
      setCopied(true);
    } catch {
      setError("Copy failed — select the key text and copy it manually.");
    }
  };

  const handleRevoke = async (id: string) => {
    setRevokingId(id);
    setError("");
    try {
      await revokeApiKey(id);
      setConfirmingRevokeId(null);
      await load();
    } catch (err: any) {
      setError(err?.message || "Failed to revoke API key.");
    } finally {
      setRevokingId(null);
    }
  };

  return (
    <div className="akp-panel">
      <p className="akp-desc">
        API keys let external MCP clients connect to <code>/mcp</code> as you. Send a key as{" "}
        <code>Authorization: Bearer cfk_…</code>. Treat a key like a password — anyone holding it
        can use your MCP tools until you revoke it.
      </p>

      {error && (
        <Notice tone="danger" onDismiss={() => setError("")}>
          {error}
        </Notice>
      )}

      {freshSecret && (
        <div className="akp-secret" role="status">
          <span className="akp-secret-label">Your new API key — copy it now:</span>
          <code className="akp-secret-value">{freshSecret}</code>
          <div className="akp-secret-actions">
            <Button size="sm" variant="primary" onClick={handleCopy}>
              {copied ? "Copied ✓" : "Copy key"}
            </Button>
            <Button size="sm" variant="secondary" onClick={() => setFreshSecret(null)}>
              Dismiss
            </Button>
          </div>
          <span className="akp-secret-note">
            You won&apos;t see this key again. The server stores only a hash of it, so a lost key
            can only be revoked and replaced.
          </span>
        </div>
      )}

      <div className="akp-mint-row">
        <TextInput
          id="akp-label"
          label="New key label"
          placeholder="e.g. Claude Desktop on my laptop"
          value={label}
          onChange={(event) => setLabel(event.target.value)}
          wrapperClassName="akp-label-field"
        />
        <Button variant="primary" onClick={handleMint} loading={minting} disabled={minting}>
          Create key
        </Button>
      </div>

      {loading ? (
        <div className="akp-loading">
          <Spinner size="sm" /> Loading your API keys…
        </div>
      ) : keys.length === 0 ? (
        <EmptyState
          title="No API keys yet"
          description="Create a key to connect an external MCP client. Keys you create appear here with their creation and last-used times."
        />
      ) : (
        <ul className="akp-list">
          {keys.map((key) => (
            <li key={key.id} className="akp-item">
              <div className="akp-item-meta">
                <span className="akp-item-label">{key.label}</span>
                <code className="akp-item-prefix">{key.prefix}…</code>
                <span className="akp-item-times">
                  Created {fmtApiKeyTime(key.createdAt)} · Last used {fmtApiKeyTime(key.lastUsedAt)}
                </span>
              </div>
              {confirmingRevokeId === key.id ? (
                <div className="akp-item-actions">
                  <span className="akp-confirm-text">Revoke this key? Clients using it stop working immediately.</span>
                  <Button
                    size="sm"
                    variant="danger"
                    onClick={() => handleRevoke(key.id)}
                    loading={revokingId === key.id}
                    disabled={revokingId === key.id}
                  >
                    Confirm revoke
                  </Button>
                  <Button size="sm" variant="secondary" onClick={() => setConfirmingRevokeId(null)}>
                    Cancel
                  </Button>
                </div>
              ) : (
                <Button
                  size="sm"
                  variant="danger"
                  tone="subtle"
                  onClick={() => setConfirmingRevokeId(key.id)}
                >
                  Revoke
                </Button>
              )}
            </li>
          ))}
        </ul>
      )}
    </div>
  );
}
