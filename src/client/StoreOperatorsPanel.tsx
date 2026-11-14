/**
 * Issue #2680 — Store operator management panel (standalone).
 *
 * Lists the effective commercial operators (env UNION store),
 * adds store operators by login, and removes store operators.
 * Env-managed rows are shown with an env badge and no remove
 * button: env operators are removed via dashboard, never via
 * the UI. Guard refusals from the server (last-operator 409,
 * env-login 409, blank-login 400) surface as plain messages.
 *
 * STANDALONE by design: this file is NOT wired into
 * PaymentWorkflowAssurance here — #2677 Slice A is editing that
 * page concurrently, and the parent wires this component into
 * the page after r80 merges. The wiring is one line (see the
 * note at the bottom of this file).
 *
 * Built only from src/client/components/ui/ primitives with
 * token-only styling (docs/agents/ux-architecture.md §20).
 * Server calls go through /api/payments/agentic/commercial/*
 * so the server sets x-user-login from the session; the
 * component never supplies an identity of its own.
 */
import React, { useCallback, useEffect, useRef, useState } from "react";
import { Badge } from "./components/ui/Badge";
import { Button } from "./components/ui/Button";
import { Card } from "./components/ui/Card";
import { EmptyState } from "./components/ui/EmptyState";
import { Notice } from "./components/ui/Notice";
import { Spinner } from "./components/ui/Spinner";
import { Table } from "./components/ui/Table";
import { TextInput } from "./components/ui/TextInput";
import { withCsrfInit } from "./apiFetch";

import { commercialPath } from "../data/commercialUrlCatalog";
const LIST_PATH = commercialPath("operators");
const ADD_PATH = commercialPath("operatorsAdd");
const REMOVE_PATH = commercialPath("operatorsRemove");

const opCardContentStyle: React.CSSProperties = {
  display: "flex",
  flexDirection: "column",
  gap: "var(--space-3)",
};
const addOperatorRowStyle: React.CSSProperties = {
  display: "flex",
  gap: "var(--space-3)",
  alignItems: "flex-end",
  flexWrap: "wrap",
  marginTop: "var(--space-3)",
  paddingTop: "var(--space-3)",
  borderTop: "1px solid var(--color-border-subtle)",
};
const addInputWrapperStyle: React.CSSProperties = {
  flex: 1,
  minWidth: "220px",
};
const opSubtitleStyle: React.CSSProperties = {
  margin: "0 0 var(--space-2)",
  color: "var(--color-text-muted)",
  fontSize: "var(--font-size-body)",
};
const opTitleStyle: React.CSSProperties = {
  margin: 0,
  fontSize: "var(--font-size-title-sm)",
  fontWeight: 600,
  color: "var(--color-text-primary)",
};

export interface EffectiveOperatorRow {
  login: string;
  source: "env" | "store";
  addedBy: string | null;
  addedAtMs: number | null;
}

async function callJson(path: string, init?: RequestInit): Promise<unknown> {
  const res = await globalThis.fetch(path, withCsrfInit(init));
  const data: unknown = await res.json().catch(() => ({}));
  if (!res.ok) {
    const message =
      data && typeof data === "object" && typeof (data as { error?: unknown }).error === "string"
        ? (data as { error: string }).error
        : `Request failed (${res.status})`;
    const error = new Error(message) as Error & { status?: number };
    error.status = res.status;
    throw error;
  }
  return data;
}

function formatTimestamp(ms: number | null): string {
  if (ms === null) return "—";
  try {
    return new Date(ms).toLocaleString();
  } catch {
    return String(ms);
  }
}

export function StoreOperatorsPanel() {
  const [operators, setOperators] = useState<EffectiveOperatorRow[]>([]);
  const [loading, setLoading] = useState(true);
  const [notOperator, setNotOperator] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [message, setMessage] = useState<string | null>(null);
  const [busy, setBusy] = useState(false);
  const loginRef = useRef<HTMLInputElement>(null);

  const refresh = useCallback(async () => {
    setLoading(true);
    setError(null);
    try {
      const data = (await callJson(LIST_PATH)) as { operators?: EffectiveOperatorRow[] };
      setOperators(Array.isArray(data.operators) ? data.operators : []);
      setNotOperator(false);
    } catch (err: any) {
      if (err?.status === 403) {
        setNotOperator(true);
        setOperators([]);
      } else {
        setError(err?.message || "Failed to load operators.");
      }
    } finally {
      setLoading(false);
    }
  }, []);

  useEffect(() => {
    void refresh();
  }, [refresh]);

  const addOperator = useCallback(async () => {
    const login = (loginRef.current?.value || "").trim();
    if (!login) {
      setError("Enter a login to add.");
      return;
    }
    setBusy(true);
    setError(null);
    setMessage(null);
    try {
      await callJson(ADD_PATH, {
        method: "POST",
        headers: { "content-type": "application/json" },
        body: JSON.stringify({ login }),
      });
      if (loginRef.current) loginRef.current.value = "";
      setMessage(`Operator ${login} added.`);
      await refresh();
    } catch (err: any) {
      setError(err?.message || "Failed to add operator.");
    } finally {
      setBusy(false);
    }
  }, [refresh]);

  const removeOperator = useCallback(
    async (login: string) => {
      setBusy(true);
      setError(null);
      setMessage(null);
      try {
        await callJson(REMOVE_PATH, {
          method: "POST",
          headers: { "content-type": "application/json" },
          body: JSON.stringify({ login }),
        });
        setMessage(`Operator ${login} removed.`);
        await refresh();
      } catch (err: any) {
        setError(err?.message || "Failed to remove operator.");
      } finally {
        setBusy(false);
      }
    },
    [refresh],
  );

  if (loading) {
    return (
      <Card>
        <Spinner label="Loading operators…" />
      </Card>
    );
  }

  if (notOperator) {
    return (
      <Card>
        <div style={opCardContentStyle}>
          <div>
            <h2 style={opTitleStyle}>Store operators</h2>
            <p style={opSubtitleStyle}>
              Effective operators are the deployment list plus the store list. Env-managed operators are removed via the
              deployment dashboard, not here; store operators are managed below. Removing the last effective operator is
              refused.
            </p>
          </div>
          <Notice tone="warning" title="Not a store operator">
            You are not a store operator, so operator management is not available to this session. Operators are
            assigned by an existing operator, or listed in the deployment&apos;s operator list by the owner.
          </Notice>
        </div>
      </Card>
    );
  }

  return (
    <Card>
      <div style={opCardContentStyle}>
        <div>
          <h2 style={opTitleStyle}>Store operators</h2>
          <p style={opSubtitleStyle}>
            Effective operators are the deployment list plus the store list. Env-managed operators are removed via the
            deployment dashboard, not here; store operators are managed below. Removing the last effective operator is
            refused.
          </p>
        </div>
        {error && (
          <Notice tone="danger" title="Operator action failed">
            {error}
          </Notice>
        )}
        {message && (
          <Notice tone="success" title="Done">
            {message}
          </Notice>
        )}
        {operators.length === 0 ? (
          <EmptyState title="No operators" description="No effective operators are listed for this deployment." />
        ) : (
          <Table
            columns={[
              { key: "login", header: "Login", render: (op) => op.login },
              {
                key: "source",
                header: "Source",
                render: (op) => (
                  <Badge tone={op.source === "env" ? "neutral" : "accent"} title={op.source === "env" ? "Env-managed: remove via dashboard" : "Store-managed"}>
                    {op.source}
                  </Badge>
                ),
              },
              { key: "addedBy", header: "Added by", render: (op) => op.addedBy ?? "—" },
              { key: "addedAt", header: "Added at", render: (op) => formatTimestamp(op.addedAtMs) },
              {
                key: "actions",
                header: "Actions",
                render: (op) =>
                  op.source === "store" ? (
                    <Button variant="secondary" size="sm" disabled={busy} onClick={() => void removeOperator(op.login)}>
                      Remove
                    </Button>
                  ) : (
                    "—"
                  ),
              },
            ]}
            rows={operators}
            rowKey={(op) => op.login}
          />
        )}
        <div style={addOperatorRowStyle}>
          <div style={addInputWrapperStyle}>
            <TextInput
              id="store-operator-login"
              name="operator-login"
              type="text"
              label="Add operator by login"
              ref={loginRef}
              placeholder="operator login"
              autoComplete="off"
            />
          </div>
          <Button variant="primary" disabled={busy} onClick={() => void addOperator()}>
            Add operator
          </Button>
        </div>
      </div>
    </Card>
  );
}

// WIRING (parent, after #2677 Slice A merges): render this panel
// inside PaymentWorkflowAssurance, e.g.:
//   import { StoreOperatorsPanel } from "./StoreOperatorsPanel";
//   ...
//   <StoreOperatorsPanel />
// No props are required; the panel reads the session from the
// server-side /api/* login header.
