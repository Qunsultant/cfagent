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
import {
  Button,
  Card,
  EmptyState,
  Flex,
  Notice,
  PageSection,
  Spinner,
  Stack,
  TextInput,
} from "./components/ui";
import {
  fetchApiKeys,
  fmtApiKeyTime,
  mintApiKey,
  revokeApiKey,
  type ApiKeyInfo,
} from "./apiKeysApi";

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
    <PageSection>
      <Stack gap="3">
      <p className="ui-meta">
        API keys let external MCP clients connect to <code className="ui-mono">/mcp</code> as you. Send a key as{" "}
        <code className="ui-mono">Authorization: Bearer cfk_…</code>. Treat a key like a password — anyone holding it
        can use your MCP tools until you revoke it.
      </p>

      {error && (
        <Notice tone="danger" onDismiss={() => setError("")}>
          {error}
        </Notice>
      )}

      {freshSecret && (
        <Notice tone="warning">
          <Stack gap="2">
            <strong>Your new API key — copy it now:</strong>
            <code className="ui-mono">{freshSecret}</code>
            <Flex gap="2" wrap>
              <Button size="sm" variant="primary" onClick={handleCopy}>
                {copied ? "Copied ✓" : "Copy key"}
              </Button>
              <Button size="sm" variant="secondary" onClick={() => setFreshSecret(null)}>
                Dismiss
              </Button>
            </Flex>
            <span className="ui-meta">
              You won&apos;t see this key again. The server stores only a hash of it, so a lost key
              can only be revoked and replaced.
            </span>
          </Stack>
        </Notice>
      )}

      <Flex gap="2" align="end" wrap>
        <TextInput
          id="akp-label"
          label="New key label"
          placeholder="e.g. Claude Desktop on my laptop"
          value={label}
          onChange={(event) => setLabel(event.target.value)}
          wrapperClassName="ui-grow"
        />
        <Button variant="primary" onClick={handleMint} loading={minting} disabled={minting}>
          Create key
        </Button>
      </Flex>

      {loading ? (
        <Flex gap="2" align="center">
          <Spinner size="sm" /> <span className="ui-meta">Loading your API keys…</span>
        </Flex>
      ) : keys.length === 0 ? (
        <EmptyState
          title="No API keys yet"
          description="Create a key to connect an external MCP client. Keys you create appear here with their creation and last-used times."
        />
      ) : (
        <Stack gap="2">
          {keys.map((key) => (
            <Card key={key.id}>
              <Flex justify="between" align="center" gap="3" wrap>
                <Stack gap="0-5">
                  <strong>{key.label}</strong>
                  <code className="ui-mono">{key.prefix}…</code>
                  <span className="ui-meta">
                    Created {fmtApiKeyTime(key.createdAt)} · Last used {fmtApiKeyTime(key.lastUsedAt)}
                  </span>
                </Stack>
                {confirmingRevokeId === key.id ? (
                  <Flex gap="2" align="center" wrap>
                    <span className="ui-danger">Revoke this key? Clients using it stop working immediately.</span>
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
                  </Flex>
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
              </Flex>
            </Card>
          ))}
        </Stack>
      )}
      </Stack>
    </PageSection>
  );
}
