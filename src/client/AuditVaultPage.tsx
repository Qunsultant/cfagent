/**
 * Issue #4575 — the Audit & Vault page.
 *
 * The ONE home for the memory vault, the real-time event log, and the
 * natural-language records surface (`?tab=audit-vault`), with each section
 * as its own URL-synced sub-tab (`?view=audit` | `?view=nlq`), following
 * the SchedulesHome / Autopilot precedent.
 *
 * Relocation, not rewrite: both sections carry the same fetches
 * (`GET /api/memory`, `GET /api/audit?limit=30`, `DELETE /api/memory?key=`,
 * `POST /api/schema/query`) and the same rendering the two inline
 * `Chat.tsx` pages had. The retired addresses (`?tab=audit`, `?tab=nlq`)
 * redirect onto these two views (`legacyAuditVaultRedirect`), so old links
 * keep landing on the same content.
 *
 * The NLQ section's ask path is the shell's `pendingPrompt` handoff: the
 * page never talks to the chat itself, it asks the shell to carry the
 * prompt, exactly as it did inline.
 */
import { useEffect, useState } from "react";
import {
  Badge,
  Button,
  Card,
  CardHeader,
  EmptyState,
  Flex,
  Grid,
  KpiRibbon,
  Modal,
  PageSection,
  PageTemplate,
  Select,
  Stack,
  Table,
  TabPanel,
  Tabs,
  TextInput,
  type TabOption,
} from "./components/ui";
import { AuditEventCard } from "./components/AuditEventCard";
import { navigateToTab, parseViewFromSearch, subscribeToRouteChanges } from "./router";
import type { AuditLogEvent, MemoryItem } from "./chat/types";

/** The page's two views, in display order. */
export const AUDIT_VAULT_VIEWS = ["audit", "nlq"] as const;
export type AuditVaultView = (typeof AUDIT_VAULT_VIEWS)[number];

export const AUDIT_VAULT_VIEW_LABELS: Record<AuditVaultView, string> = {
  audit: "Audit Vault",
  nlq: "Records NLQ",
};

const AUDIT_VAULT_TABS: TabOption<AuditVaultView>[] = AUDIT_VAULT_VIEWS.map((id) => ({
  id,
  label: AUDIT_VAULT_VIEW_LABELS[id],
}));

/** Whether a value is one of this page's view ids. */
export function isAuditVaultView(value: unknown): value is AuditVaultView {
  return typeof value === "string" && (AUDIT_VAULT_VIEWS as readonly string[]).includes(value);
}

function readViewFromUrl(): AuditVaultView {
  if (typeof window === "undefined") return "audit";
  return (parseViewFromSearch(window.location.search, isAuditVaultView) as AuditVaultView | null) ?? "audit";
}

interface BrowsedTable {
  tableName: string;
  total: number;
  rows: Record<string, unknown>[];
}

export interface AuditVaultPageProps {
  /** The chat is streaming/submitted — the ask button waits, as inline did. */
  isBusy?: boolean;
  /** Hand a natural-language prompt to the shell's chat (pendingPrompt). */
  onAsk?: (prompt: string, sourceTab: string) => void;
}

export function AuditVaultPage({ isBusy = false, onAsk }: AuditVaultPageProps) {
  const [view, setView] = useState<AuditVaultView>(readViewFromUrl);

  useEffect(
    () =>
      subscribeToRouteChanges(() => {
        setView(readViewFromUrl());
      }),
    [],
  );

  // --- Audit view state -------------------------------------------------
  const [auditEvents, setAuditEvents] = useState<AuditLogEvent[]>([]);
  const [memories, setMemories] = useState<MemoryItem[]>([]);
  const [auditLoading, setAuditLoading] = useState(false);
  const [memoryToDelete, setMemoryToDelete] = useState<string | null>(null);

  const fetchAuditData = async () => {
    setAuditLoading(true);
    try {
      const [auditResp, memResp] = await Promise.all([
        fetch("/api/audit?limit=30")
          .then((r) => r.json() as Promise<{ events?: AuditLogEvent[] }>)
          .catch(() => ({ events: [] })),
        fetch("/api/memory")
          .then((r) => r.json() as Promise<{ memories?: MemoryItem[] }>)
          .catch(() => ({ memories: [] })),
      ]);
      setAuditEvents(auditResp.events || []);
      setMemories(memResp.memories || []);
    } finally {
      setAuditLoading(false);
    }
  };

  useEffect(() => {
    if (view === "audit") void fetchAuditData();
  }, [view]);

  const confirmDeleteMemory = async () => {
    const key = memoryToDelete;
    setMemoryToDelete(null);
    if (!key) return;
    try {
      await fetch(`/api/memory?key=${encodeURIComponent(key)}`, { method: "DELETE" });
      setMemories((prev) => prev.filter((m) => m.key !== key));
    } catch {
      // Fail soft: the list keeps the row until the next refresh.
    }
  };

  // --- NLQ view state ---------------------------------------------------
  const [nlqInput, setNlqInput] = useState("");
  const [selectedBrowseTable, setSelectedBrowseTable] = useState("mas_categories");
  const [browseSearch, setBrowseSearch] = useState("");
  const [browsedData, setBrowsedData] = useState<BrowsedTable | null>(null);
  const [browsingLoading, setBrowsingLoading] = useState(false);
  const [browsedDetailRow, setBrowsedDetailRow] = useState<Record<string, unknown> | null>(null);

  const browseTable = async (tableName: string, search?: string) => {
    setBrowsingLoading(true);
    try {
      const resp = await fetch("/api/schema/query", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ table: tableName, search: search || "" }),
      });
      setBrowsedData((await resp.json()) as BrowsedTable);
    } catch {
      setBrowsedData(null);
    } finally {
      setBrowsingLoading(false);
    }
  };

  const ask = (prompt: string) => {
    const trimmed = prompt.trim();
    if (!trimmed) return;
    onAsk?.(trimmed, "Records Explorer");
    setNlqInput("");
  };

  return (
    <PageTemplate
      title="Audit & Vault"
      scopeNote="The memory vault, the live event stream, and the natural-language records surface — one menu, two views."
      kpiRibbon={
        <KpiRibbon
          items={[
            { label: "Persistent facts", value: String(memories.length) },
            { label: "Audit events", value: String(auditEvents.length) },
          ]}
        />
      }
    >
      <Tabs<AuditVaultView>
        idBase="audit-vault"
        ariaLabel="Audit & Vault views"
        tabs={AUDIT_VAULT_TABS}
        value={view}
        onChange={(next) => navigateToTab("audit-vault", next)}
      />

      <TabPanel idBase="audit-vault" tabId="audit" active={view === "audit"}>
        <PageSection
          title="System Audit & Memory Vault"
          description="Live observability stream into router decisions, sub-agent executions, AI decision evaluations, and firm memory state."
        >
          <div>
            <Button variant="secondary" size="sm" onClick={() => void fetchAuditData()} disabled={auditLoading} loading={auditLoading}>
              {"🔄 Refresh Data"}
            </Button>
          </div>

          <Grid columns={2} gap="3">
            <PageSection>
              <Card>
                <CardHeader
                  title="🧠 Persistent Memory Vault"
                  meta={
                    <Badge size="xs" tone="info">{memories.length} facts</Badge>
                  }
                />
                {memories.length === 0 ? (
                  <EmptyState icon="🧠" title="No memories saved yet" description='Try asking the assistant to "Remember that..."' />
                ) : (
                  <Stack gap="2">
                    {memories.map((m) => (
                      <Card padding="sm" key={m.key}>
                        <Stack gap="1">
                          <Flex justify="between" align="center" gap="2">
                            <span className="ui-mono">🔑 {m.key}</span>
                            <Button
                              variant="ghost"
                              size="sm"
                              onClick={() => setMemoryToDelete(m.key)}
                              title="Delete memory"
                            >
                              ×
                            </Button>
                          </Flex>
                          <div>{m.value}</div>
                          <span className="ui-meta-sm">{new Date(m.updatedAt).toLocaleString()}</span>
                        </Stack>
                      </Card>
                    ))}
                  </Stack>
                )}
              </Card>
            </PageSection>

            <PageSection>
              <Card>
                <CardHeader
                  title="📋 Real-time Event Log"
                  meta={
                    <Badge size="xs" tone="info">{auditEvents.length} events</Badge>
                  }
                />
                {auditEvents.length === 0 ? (
                  <EmptyState icon="📋" title="No audit events logged yet" />
                ) : (
                  <Stack gap="2">
                    {auditEvents.map((e) => <AuditEventCard key={e.id} event={e} />)}
                  </Stack>
                )}
              </Card>
            </PageSection>
          </Grid>
        </PageSection>
      </TabPanel>

      <TabPanel idBase="audit-vault" tabId="nlq" active={view === "nlq"}>
        <PageSection
          title="Natural Language Records & Audit Analytics"
          description="Query business records, inspect enterprise data schemas, retrieve transaction records, and browse commercial records."
        >
          <Flex gap="2" align="center" wrap>
            <span className="ui-label">Natural Language Queries:</span>
            <Button variant="secondary" tone="subtle" size="sm" onClick={() => setNlqInput("List all database tables and schema")}>
              🗄️ List tables & schema
            </Button>
            <Button variant="secondary" tone="subtle" size="sm" onClick={() => setNlqInput("Show referral categories in categories table")}>
              🏷️ Show categories table data
            </Button>
            <Button variant="secondary" tone="subtle" size="sm" onClick={() => setNlqInput("Add category 'Web3 & Crypto' to categories table")}>
              ➕ Add category 'Web3 & Crypto'
            </Button>
            <Button variant="secondary" tone="subtle" size="sm" onClick={() => setNlqInput("Show external ads inventory and earnings")}>
              📢 Show external ads & earnings
            </Button>
            <Button variant="secondary" tone="subtle" size="sm" onClick={() => setNlqInput("Show transactions and payment records")}>
              💳 Show transaction ledger
            </Button>
            <Button variant="secondary" tone="subtle" size="sm" onClick={() => setNlqInput("List all user questions asked")}>
              💬 List user questions
            </Button>
          </Flex>

          <form
            onSubmit={(event) => {
              event.preventDefault();
              ask(nlqInput);
            }}
          >
            <Flex gap="2" align="center">
              <TextInput
                type="text"
                value={nlqInput}
                onChange={(e) => setNlqInput(e.target.value)}
                placeholder="Ask the shared chat about database records or categories…"
                wrapperClassName="ui-grow"
              />
              <Button type="submit" variant="primary" disabled={!nlqInput.trim() || isBusy}>
                Ask in Chat
              </Button>
            </Flex>
          </form>
        </PageSection>

        <PageSection>
          {/* Record Explorer toolbar — the same direct ORM browse path. */}
          <Flex gap="2" align="center" wrap>
            <span className="ui-label">⚡ RECORD EXPLORER:</span>
            <Select
              value={selectedBrowseTable}
              onChange={(e) => setSelectedBrowseTable(e.target.value)}
            >
              <option value="mas_categories">🏷️ mas_categories (Referral Categories)</option>
              <option value="mas_referrals">🔗 mas_referrals (Referral Links)</option>
              <option value="mas_external_ads">📡 mas_external_ads (Ad Networks)</option>
              <option value="mas_ads">🚀 mas_ads (Sponsored Deals)</option>
              <option value="mas_transactions">💳 mas_transactions (Payments & DIDs)</option>
              <option value="mas_messages">💬 mas_messages (Conversation History)</option>
              <option value="mas_memory">🧠 mas_memory (Session Facts)</option>
              <option value="mas_events">🛡️ mas_events (Audit Log)</option>
            </Select>

            <TextInput
              value={browseSearch}
              onChange={(e) => setBrowseSearch(e.target.value)}
              placeholder="Search table text…"
              aria-label="Search table text"
              wrapperClassName="ui-grow"
            />

            <Button
              variant="primary"
              onClick={() => browseTable(selectedBrowseTable, browseSearch)}
              loading={browsingLoading}
            >
              {"🔍 Browse Records"}
            </Button>
          </Flex>

          {browsedData && (
            <Card>
              <CardHeader
                title={
                  <span>
                    🗄️ Table Data: <strong>{browsedData.tableName}</strong>
                  </span>
                }
                meta={
                  <Flex gap="2" align="center">
                    <Badge size="xs" tone="neutral">{browsedData.total} Total Records</Badge>
                    <Button variant="ghost" size="sm" onClick={() => setBrowsedData(null)} title="Close browsed table">
                      ✕ Close
                    </Button>
                  </Flex>
                }
              />

              {browsedData.rows && browsedData.rows.length > 0 ? (
                <div className="ui-scroll-x">
                  <Table
                    columns={Object.keys(browsedData.rows[0]).map((col) => ({
                      key: col,
                      header: col,
                      cellClassName: "table-data-cell",
                      render: (row: Record<string, unknown>) =>
                        typeof row[col] === "object" && row[col] !== null ? JSON.stringify(row[col]) : String(row[col] ?? "—"),
                    }))}
                    rows={browsedData.rows.map((row, i) => ({ ...row, __rowKey: String(i) }))}
                    rowKey={(row: Record<string, unknown>) => String(row.__rowKey)}
                    onRowClick={(row: Record<string, unknown>) => setBrowsedDetailRow(row)}
                  />
                </div>
              ) : (
                <EmptyState title={`No records found in table ${browsedData.tableName}`} />
              )}
            </Card>
          )}

          {/* #1968: full-payload detail view. Table cells show one-line
              values; a JSON TEXT column (e.g. mas_events.payload) is only
              usable expanded, so clicking a row opens the whole record
              as pretty JSON — string values that parse as JSON are
              expanded one level (payload text becomes an object). */}
          {browsedDetailRow && (
            <Modal
              open={true}
              onClose={() => setBrowsedDetailRow(null)}
              title={`Record detail: ${browsedData?.tableName ?? "row"}`}
            >
              <pre className="ui-pre">
                {(() => {
                  const expanded: Record<string, unknown> = {};
                  for (const [k, v] of Object.entries(browsedDetailRow)) {
                    if (k === "__rowKey") continue;
                    if (typeof v === "string") {
                      try {
                        expanded[k] = JSON.parse(v);
                      } catch {
                        expanded[k] = v;
                      }
                    } else {
                      expanded[k] = v;
                    }
                  }
                  return JSON.stringify(expanded, null, 2);
                })()}
              </pre>
            </Modal>
          )}
        </PageSection>
      </TabPanel>

      <Modal open={memoryToDelete !== null} onClose={() => setMemoryToDelete(null)} title="Delete memory?">
        <>
          <p>
            Delete memory &quot;{memoryToDelete}&quot;? This cannot be undone.
          </p>
          <Button type="button" variant="primary" onClick={() => void confirmDeleteMemory()}>
            Delete
          </Button>{" "}
          <Button type="button" variant="secondary" onClick={() => setMemoryToDelete(null)}>
            Cancel
          </Button>
        </>
      </Modal>
    </PageTemplate>
  );
}
