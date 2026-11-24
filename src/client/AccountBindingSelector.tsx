/**
 * Issue #5113 & #5097 (Sub-issues of #5094) — Account & Asset-Class Binding Selector
 * and runtime-configurable Broker / Asset-Type / Account-Type Registry Manager.
 *
 * Built strictly from `src/client/components/ui` primitives with token-only
 * styling (`docs/architecture/UX/ux-architecture.md` §20), synced with
 * `/api/broker/account-binding` and the `broker_account_binding` chat tool.
 */
import React, { useEffect, useState } from "react";
import {
  Badge,
  Button,
  Card,
  CardHeader,
  Flex,
  Notice,
  Select,
  Stack,
  TextInput,
} from "./components/ui";
import { ACCOUNT_BINDING_SCOPES } from "../config/accountBindings";
import { fetchBrokerAccounts } from "./accountBindingStore";
import { withCsrfInit } from "./apiFetch";
import {
  buildDefaultBrokerAssetAccountRegistry,
  type AccountBinding,
  type AccountBindingScope,
  type AccountType,
  type BrokerAssetAccountRegistry,
  type BrokerAssetAccountRegistryPatch,
} from "../trading";

type BindingFailureBody = {
  ok?: boolean;
  message?: unknown;
  error?: unknown;
  code?: unknown;
};

/**
 * Issue #6225 — surface the coded reason on a failed save/patch.
 * The three failure bodies disagree on field names: the CSRF-gate
 * 403 carries {error, code}, the validated path {ok:false, code,
 * error}, the plain upsert {code, message}. Prefer the human text
 * (message, else error) and append the code when the text does not
 * already carry it, so the code (e.g. csrf_invalid) is visible
 * instead of only the generic fallback.
 */
function describeBindingFailure(data: BindingFailureBody, fallback: string): string {
  const message =
    typeof data.message === "string" && data.message.length > 0 ? data.message : null;
  const error = typeof data.error === "string" && data.error.length > 0 ? data.error : null;
  const code = typeof data.code === "string" && data.code.length > 0 ? data.code : null;
  const detail = message ?? error;
  if (detail && code && !detail.includes(code)) return `${detail} [${code}]`;
  if (detail) return detail;
  if (code) return `[${code}] ${fallback}`;
  return fallback;
}

export interface AccountBindingSelectorProps {
  broker: string;
  mode: "paper" | "live";
  /**
   * #6147 S2 — which half this mount shows first. The component holds
   * both halves in one Card (bindings form + collapsible Registry
   * Manager); the registry half is the same state and save path as
   * the bindings half, so the slice mounts ONE component per view
   * with this prop instead of splitting it. "registry" opens with
   * the Registry Manager expanded; "binding" (default) opens with
   * the bindings form and the registry collapsed. The user can still
   * toggle between halves with the Manage Registry button.
   */
  section?: "registry" | "binding";
  initialBindings?: AccountBinding[];
  initialRegistry?: BrokerAssetAccountRegistry;
  availableAccounts?: Array<{ accountId: string; accountName?: string }>;
  onSaved?: (binding: AccountBinding) => void;
  onRegistryUpdated?: (registry: BrokerAssetAccountRegistry) => void;
}

export function AccountBindingSelector({
  broker,
  mode,
  section = "binding",
  initialBindings,
  initialRegistry,
  availableAccounts = [],
  onSaved,
  onRegistryUpdated,
}: AccountBindingSelectorProps) {
  const [registry, setRegistry] = useState<BrokerAssetAccountRegistry>(
    () => initialRegistry ?? buildDefaultBrokerAssetAccountRegistry(),
  );
  const [bindings, setBindings] = useState<AccountBinding[]>(initialBindings ?? []);
  const [selectedBroker, setSelectedBroker] = useState<string>(broker);
  const [accountType, setAccountType] = useState<AccountType>("stock");
  const [scope, setScope] = useState<AccountBindingScope>("tenant");
  const [accountId, setAccountId] = useState<string>(availableAccounts[0]?.accountId ?? "");
  const [saving, setSaving] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [statusMessage, setStatusMessage] = useState<string | null>(null);

  // #6147 S2: the registry view lands with the Registry Manager open.
  const [showRegistryManager, setShowRegistryManager] = useState(section === "registry");
  const [newBrokerId, setNewBrokerId] = useState("");
  const [newBrokerLabel, setNewBrokerLabel] = useState("");
  const [newAssetType, setNewAssetType] = useState("");
  const [newAccountType, setNewAccountType] = useState("");

  useEffect(() => {
    setSelectedBroker(broker);
  }, [broker]);

  useEffect(() => {
    if (initialBindings && initialRegistry) return;
    let active = true;
    fetch(`/api/broker/account-binding?broker=${encodeURIComponent(broker)}&mode=${encodeURIComponent(mode)}`)
      .then((res) =>
        res.ok
          ? (res.json() as Promise<{
              bindings?: AccountBinding[];
              registry?: BrokerAssetAccountRegistry;
            }>)
          : Promise.reject(new Error(`HTTP ${res.status}`)),
      )
      .then((data) => {
        if (!active) return;
        if (Array.isArray(data.bindings) && !initialBindings) {
          setBindings(data.bindings);
        }
        if (data.registry && !initialRegistry) {
          setRegistry(data.registry);
        }
      })
      .catch(() => {
        // Non-fatal on initial load; user can still save a binding.
      });
    return () => {
      active = false;
    };
  }, [broker, mode, initialBindings, initialRegistry]);

  async function applyRegistryPatch(patch: BrokerAssetAccountRegistryPatch, successMsg: string) {
    setSaving(true);
    setError(null);
    setStatusMessage(null);
    try {
      const res = await fetch(
        "/api/broker/account-binding",
        // Issue #6225 — the CSRF gate (#3113) 403s every cookie-authenticated
        // mutation missing the X-CSRF-Token header before any route work.
        withCsrfInit({
          method: "PUT",
          headers: { "Content-Type": "application/json" },
          body: JSON.stringify({ registryPatch: patch }),
        }),
      );
      const data = (await res.json().catch(() => ({}))) as {
        ok?: boolean;
        registry?: BrokerAssetAccountRegistry;
        message?: string;
        error?: string;
        code?: string;
      };
      if (!res.ok || !data.registry) {
        setError(describeBindingFailure(data, "Failed to update registry."));
        return;
      }
      setRegistry(data.registry);
      setStatusMessage(successMsg);
      onRegistryUpdated?.(data.registry);
    } catch {
      setError("Network error updating registry.");
    } finally {
      setSaving(false);
    }
  }

  async function handleSave() {
    if (!accountId.trim()) {
      setError("Enter or select an account ID.");
      return;
    }
    setSaving(true);
    setError(null);
    setStatusMessage(null);
    try {
      // Issue #5099 (F2): validate the save against the broker's real
      // accounts when the accounts read serves the broker being saved.
      // GET /api/broker/accounts serves the SELECTED broker — when the
      // selector is saving another broker (or the read fails / is gated
      // off), fall back to the plain upsert (the pre-F2 behavior). The
      // fresh read also supplies the matched account name when the
      // menu passed no `availableAccounts` prop.
      const read = await fetchBrokerAccounts();
      const validatedAccounts =
        read && read.broker === selectedBroker ? read.accounts : null;
      const matched = (validatedAccounts ?? availableAccounts).find(
        (a) => a.accountId === accountId.trim(),
      );
      const res = await fetch(
        "/api/broker/account-binding",
        // Issue #6225 — see applyRegistryPatch: the PUT must carry the
        // CSRF token or the #3113 gate 403s it as csrf_invalid.
        withCsrfInit({
          method: "PUT",
          headers: { "Content-Type": "application/json" },
          body: JSON.stringify({
            broker: selectedBroker,
            mode,
            accountType,
            scope,
            accountId: accountId.trim(),
            accountName: matched?.accountName,
            ...(validatedAccounts ? { availableAccounts: validatedAccounts } : {}),
          }),
        }),
      );
      const data = (await res.json().catch(() => ({}))) as {
        ok?: boolean;
        binding?: AccountBinding;
        message?: string;
        error?: string;
        code?: string;
      };
      if (!res.ok || !data.binding) {
        setError(describeBindingFailure(data, "Failed to save account binding."));
        return;
      }
      setBindings((prev) => [
        ...prev.filter(
          (b) =>
            !(
              b.broker === data.binding!.broker &&
              b.mode === data.binding!.mode &&
              b.accountType === data.binding!.accountType &&
              b.scope === data.binding!.scope
            ),
        ),
        data.binding!,
      ]);
      setStatusMessage(
        `Bound ${data.binding.broker} (${data.binding.mode} · ${data.binding.accountType} · ${data.binding.scope}) to ${data.binding.accountId}.`,
      );
      onSaved?.(data.binding);
    } catch {
      setError("Network error saving account binding.");
    } finally {
      setSaving(false);
    }
  }

  const enabledBrokers = registry.brokers.filter((b) => b.enabled);

  return (
    <Card>
      <CardHeader
        title="Account & Asset-Class Binding"
        meta={
          <Flex gap="2" align="center">
            <Badge tone={mode === "live" ? "warning" : "info"}>
              {selectedBroker.toUpperCase()} · {mode.toUpperCase()}
            </Badge>
            <Button
              variant="secondary"
              size="sm"
              onClick={() => setShowRegistryManager((prev) => !prev)}
            >
              {showRegistryManager ? "Hide Registry" : "Manage Registry"}
            </Button>
          </Flex>
        }
      />
      <Stack gap="3">
        {error ? <Notice tone="danger">{error}</Notice> : null}
        {statusMessage ? <Notice tone="success">{statusMessage}</Notice> : null}

        <Flex gap="2" wrap={true}>
          <Select
            label="Broker"
            value={selectedBroker}
            onChange={(e) => setSelectedBroker(e.target.value)}
          >
            {enabledBrokers.map((b) => (
              <option key={b.id} value={b.id}>
                {b.label} ({b.id})
              </option>
            ))}
          </Select>

          <Select
            label="Account Type"
            value={accountType}
            onChange={(e) => setAccountType(e.target.value as AccountType)}
          >
            {registry.accountTypes.map((t) => (
              <option key={t} value={t}>
                {t}
              </option>
            ))}
          </Select>

          <Select
            label="Surface Scope"
            value={scope}
            onChange={(e) => setScope(e.target.value as AccountBindingScope)}
          >
            {ACCOUNT_BINDING_SCOPES.map((s) => (
              <option key={s} value={s}>
                {s}
              </option>
            ))}
          </Select>

          <TextInput
            label="Account ID"
            value={accountId}
            placeholder="e.g. U1234567"
            onChange={(e) => setAccountId(e.target.value)}
          />
        </Flex>

        <Flex gap="2">
          <Button variant="primary" loading={saving} onClick={handleSave}>
            Bind Account
          </Button>
        </Flex>

        {showRegistryManager ? (
          <Card>
            <CardHeader title="Broker, Asset-Type & Account-Type Registry" />
            <Stack gap="2">
              <Flex gap="2" wrap={true} align="end">
                <TextInput
                  label="New / Edit Broker ID"
                  value={newBrokerId}
                  placeholder="e.g. prime_fx"
                  onChange={(e) => setNewBrokerId(e.target.value)}
                />
                <TextInput
                  label="Broker Label"
                  value={newBrokerLabel}
                  placeholder="e.g. Prime FX Brokerage"
                  onChange={(e) => setNewBrokerLabel(e.target.value)}
                />
                <Button
                  variant="secondary"
                  loading={saving}
                  onClick={() => {
                    if (!newBrokerId.trim()) return;
                    const id = newBrokerId.trim().toLowerCase();
                    const label = newBrokerLabel.trim() || id.toUpperCase();
                    setNewBrokerId("");
                    setNewBrokerLabel("");
                    void applyRegistryPatch(
                      { upsertBroker: { id, label, enabled: true, modes: ["paper", "live"] } },
                      `Registered broker ${label} (${id}).`,
                    );
                  }}
                >
                  Save Broker
                </Button>
              </Flex>

              <Flex gap="2" wrap={true} align="end">
                <TextInput
                  label="Add Asset Type"
                  value={newAssetType}
                  placeholder="e.g. bonds"
                  onChange={(e) => setNewAssetType(e.target.value)}
                />
                <Button
                  variant="secondary"
                  loading={saving}
                  onClick={() => {
                    if (!newAssetType.trim()) return;
                    const token = newAssetType.trim().toLowerCase();
                    setNewAssetType("");
                    void applyRegistryPatch(
                      { addAssetType: token },
                      `Added asset type ${token}.`,
                    );
                  }}
                >
                  Add Asset Type
                </Button>

                <TextInput
                  label="Add Account Type"
                  value={newAccountType}
                  placeholder="e.g. roth_ira"
                  onChange={(e) => setNewAccountType(e.target.value)}
                />
                <Button
                  variant="secondary"
                  loading={saving}
                  onClick={() => {
                    if (!newAccountType.trim()) return;
                    const token = newAccountType.trim().toLowerCase();
                    setNewAccountType("");
                    void applyRegistryPatch(
                      { addAccountType: token },
                      `Added account type ${token}.`,
                    );
                  }}
                >
                  Add Account Type
                </Button>
              </Flex>

              <Flex gap="1" wrap={true}>
                {registry.brokers.map((b) => (
                  <Button
                    key={b.id}
                    variant="secondary"
                    size="sm"
                    onClick={() =>
                      void applyRegistryPatch(
                        { upsertBroker: { id: b.id, enabled: !b.enabled } },
                        `${b.enabled ? "Disabled" : "Enabled"} broker ${b.label}.`,
                      )
                    }
                  >
                    {b.label}: {b.enabled ? "Enabled" : "Disabled"}
                  </Button>
                ))}
              </Flex>
            </Stack>
          </Card>
        ) : null}

        {bindings.length > 0 ? (
          <Stack gap="1">
            {bindings.map((b) => (
              <Flex
                key={`${b.broker}:${b.mode}:${b.accountType}:${b.scope}`}
                gap="2"
                align="center"
              >
                <Badge tone="neutral">{b.broker}</Badge>
                <Badge tone={b.mode === "live" ? "warning" : "info"}>{b.mode}</Badge>
                <Badge tone="accent">{b.accountType}</Badge>
                <Badge tone="neutral">{b.scope}</Badge>
                <span>{b.accountName ? `${b.accountName} (${b.accountId})` : b.accountId}</span>
              </Flex>
            ))}
          </Stack>
        ) : null}
      </Stack>
    </Card>
  );
}
