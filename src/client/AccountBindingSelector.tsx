/**
 * Issue #5113 (Sub-issue 4 of #5094) — Account & Asset-Class Binding Selector.
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
import {
  ACCOUNT_BINDING_SCOPES,
  ACCOUNT_TYPES,
} from "../config/accountBindings";
import type {
  AccountBinding,
  AccountBindingScope,
  AccountType,
} from "../trading";

export interface AccountBindingSelectorProps {
  broker: string;
  mode: "paper" | "live";
  initialBindings?: AccountBinding[];
  availableAccounts?: Array<{ accountId: string; accountName?: string }>;
  onSaved?: (binding: AccountBinding) => void;
}

export function AccountBindingSelector({
  broker,
  mode,
  initialBindings,
  availableAccounts = [],
  onSaved,
}: AccountBindingSelectorProps) {
  const [bindings, setBindings] = useState<AccountBinding[]>(initialBindings ?? []);
  const [accountType, setAccountType] = useState<AccountType>("stock");
  const [scope, setScope] = useState<AccountBindingScope>("tenant");
  const [accountId, setAccountId] = useState<string>(availableAccounts[0]?.accountId ?? "");
  const [saving, setSaving] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [statusMessage, setStatusMessage] = useState<string | null>(null);

  useEffect(() => {
    if (initialBindings) return;
    let active = true;
    fetch(`/api/broker/account-binding?broker=${encodeURIComponent(broker)}&mode=${encodeURIComponent(mode)}`)
      .then((res) => (res.ok ? (res.json() as Promise<{ bindings?: AccountBinding[] }>) : Promise.reject(new Error(`HTTP ${res.status}`))))
      .then((data) => {
        if (active && Array.isArray(data.bindings)) {
          setBindings(data.bindings);
        }
      })
      .catch(() => {
        // Non-fatal on initial load; user can still save a binding.
      });
    return () => {
      active = false;
    };
  }, [broker, mode, initialBindings]);

  async function handleSave() {
    if (!accountId.trim()) {
      setError("Enter or select an account ID.");
      return;
    }
    setSaving(true);
    setError(null);
    setStatusMessage(null);
    try {
      const matched = availableAccounts.find((a) => a.accountId === accountId.trim());
      const res = await fetch("/api/broker/account-binding", {
        method: "PUT",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({
          broker,
          mode,
          accountType,
          scope,
          accountId: accountId.trim(),
          accountName: matched?.accountName,
        }),
      });
      const data = (await res.json().catch(() => ({}))) as {
        ok?: boolean;
        binding?: AccountBinding;
        message?: string;
      };
      if (!res.ok || !data.binding) {
        setError(data.message || "Failed to save account binding.");
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

  return (
    <Card>
      <CardHeader
        title="Account & Asset-Class Binding"
        meta={
          <Badge tone={mode === "live" ? "warning" : "info"}>
            {broker.toUpperCase()} · {mode.toUpperCase()}
          </Badge>
        }
      />
      <Stack gap="3">
        {error ? <Notice tone="danger">{error}</Notice> : null}
        {statusMessage ? <Notice tone="success">{statusMessage}</Notice> : null}

        <Flex gap="2" wrap={true}>
          <Select
            label="Account Type"
            value={accountType}
            onChange={(e) => setAccountType(e.target.value as AccountType)}
          >
            {ACCOUNT_TYPES.map((t) => (
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
