/**
 * #6151 S4 — Nav & Menu Access admin screen.
 *
 * Platform admins edit the per-tenant allowance (what a tenant's
 * users may ever see), per-user allow-lists (what one user sees),
 * and the persona-default preset each persona starts from.
 * Tenant admins edit per-user rows for their own tenant only.
 * Everything here is presentation: the server refuses anything
 * wider than the tenant allowance, a tenant-admin write outside
 * their own tenant, and a saved-preset apply when saved presets
 * are disallowed — the screen surfaces the server's refusal
 * instead of re-checking the rule itself.
 *
 * Persona comes from the shared platform context (never a direct
 * role fetch — see the platform-context census). Saving a row
 * invalidates + re-fetches that context so the admin's own menu
 * re-reads on the next availability call.
 *
 * Primitives only, token-only styling, zero bespoke CSS.
 */
import { useEffect, useMemo, useState } from "react";
import {
  Button,
  Card,
  CardHeader,
  Checkbox,
  EmptyState,
  Notice,
  PageSection,
  Select,
  SmallHeader,
  Spinner,
  Stack,
  TextInput,
  useToast,
} from "./components/ui";
import {
  DEFAULT_LEFT_NAV_CONFIG,
  builtinPresetKeys,
  enumerateNavAvailabilityIds,
  navSubItemAvailabilityKey,
  type NavPersona,
} from "./navConfig";
import { NAV_PRESET_LABELS } from "./navPresets";
import { NAV_PERSONAS } from "../data/navAdminConfigPorts";
import {
  fetchNavAdminConfig,
  resetPersonaDefault,
  savePersonaDefault,
  saveTenantAllowance,
  saveUserAllowlist,
  type NavAdminConfigResponse,
} from "./navAdminApi";
import { fetchTenants } from "./tenantAdminApi";
import {
  fetchPlatformContext,
  invalidatePlatformContext,
  usePlatformContext,
} from "./platformContextStore";

const ALL_NAV_IDS = enumerateNavAvailabilityIds();

function toggleIn(set: ReadonlySet<string>, id: string): Set<string> {
  const next = new Set(set);
  if (next.has(id)) next.delete(id);
  else next.add(id);
  return next;
}

function NavIdCheckboxes(props: {
  value: ReadonlySet<string>;
  disabled: boolean;
  onChange: (next: Set<string>) => void;
}): React.JSX.Element {
  const { value, disabled, onChange } = props;
  return (
    <Stack gap="2">
      {DEFAULT_LEFT_NAV_CONFIG.sections.map((section) => (
        <Stack key={section.id} gap="1">
          <SmallHeader title={section.title} />
          {section.items.map((item) => {
            const subKeys = (item.subItems ?? []).map((sub) =>
              navSubItemAvailabilityKey(item.id, sub.id),
            );
            const checked = value.has(item.id);
            const toggleParent = () => {
              const next = toggleIn(value, item.id);
              for (const key of subKeys) {
                if (checked) next.delete(key);
                else next.add(key);
              }
              onChange(next);
            };
            return (
              <Stack key={item.id} gap="1">
                <Checkbox
                  label={item.label}
                  checked={checked}
                  disabled={disabled}
                  onChange={toggleParent}
                />
                {(item.subItems ?? []).map((sub) => {
                  const key = navSubItemAvailabilityKey(item.id, sub.id);
                  return (
                    <div key={key} style={{ paddingLeft: "var(--space-4)" }}>
                      <Checkbox
                        label={sub.label}
                        checked={value.has(key)}
                        disabled={disabled}
                        onChange={() => onChange(toggleIn(value, key))}
                      />
                    </div>
                  );
                })}
              </Stack>
            );
          })}
        </Stack>
      ))}
    </Stack>
  );
}

export default function NavAdminConfigPanel(): React.JSX.Element {
  const platformContext = usePlatformContext();
  const persona = platformContext?.persona ?? "non-paid";
  const toast = useToast();
  const [config, setConfig] = useState<NavAdminConfigResponse | null>(null);
  const [tenantIds, setTenantIds] = useState<string[]>([]);
  const [loading, setLoading] = useState(true);
  const [error, setError] = useState<string | null>(null);
  const [selectedTenant, setSelectedTenant] = useState<string | null>(null);
  const [allowanceDraft, setAllowanceDraft] = useState<Set<string>>(new Set());
  const [selectedUser, setSelectedUser] = useState<string | null>(null);
  const [allowlistDraft, setAllowlistDraft] = useState<Set<string>>(new Set());
  const [presetsAllowed, setPresetsAllowed] = useState(true);
  const [typedUserId, setTypedUserId] = useState("");
  const [personaDraft, setPersonaDraft] = useState<Record<string, string>>({});
  const [saving, setSaving] = useState<"allowance" | "allowlist" | string | null>(null);

  const isPlatformAdmin = persona === "platform-admin";
  const isAdmin = persona === "platform-admin" || persona === "tenant-admin";

  useEffect(() => {
    let cancelled = false;
    (async () => {
      try {
        const loaded = await fetchNavAdminConfig();
        if (cancelled) return;
        setConfig(loaded);
        setPersonaDraft(
          Object.fromEntries(
            loaded.personaDefaults.map((row) => [row.persona, row.presetKey]),
          ),
        );
        if (loaded.scope === "platform") {
          try {
            const tenants = await fetchTenants();
            if (!cancelled) setTenantIds(tenants.map((t) => t.tenantId));
          } catch {
            // Tenant list unavailable — the allowance editor falls
            // back to tenants that already have rows.
            if (!cancelled) {
              setTenantIds(loaded.allowances.map((r) => r.tenantId));
            }
          }
        } else {
          setTenantIds([loaded.tenantId]);
          setSelectedTenant(loaded.tenantId);
        }
      } catch (err) {
        if (!cancelled) {
          setError(err instanceof Error ? err.message : "Failed to load nav config.");
        }
      } finally {
        if (!cancelled) setLoading(false);
      }
    })();
    return () => {
      cancelled = true;
    };
  }, []);

  // Default the platform-admin tenant picker to the first tenant
  // that already has an allowance, else the first known tenant.
  useEffect(() => {
    if (!config || config.scope !== "platform" || selectedTenant) return;
    const first =
      config.allowances[0]?.tenantId ?? tenantIds[0] ?? null;
    if (first) setSelectedTenant(first);
  }, [config, tenantIds, selectedTenant]);

  // Allowance draft follows the selected tenant: its stored row,
  // or everything (no allowance = the tenant gets everything).
  useEffect(() => {
    if (!config || !selectedTenant) return;
    const row = config.allowances.find((r) => r.tenantId === selectedTenant);
    setAllowanceDraft(new Set(row ? row.allowedIds : ALL_NAV_IDS));
  }, [config, selectedTenant]);

  const memberUserIds = useMemo(() => {
    if (!config || !selectedTenant) return [];
    const fromMembers =
      config.tenantMembers.find((entry) => entry.tenantId === selectedTenant)
        ?.userIds ?? [];
    const fromRows = config.allowlists
      .filter((row) => row.tenantId === selectedTenant)
      .map((row) => row.userId);
    return [...new Set([...fromMembers, ...fromRows])].sort();
  }, [config, selectedTenant]);

  // Allow-list draft follows the selected user: their stored row,
  // or the full tenant allowance (a new user starts with
  // everything the tenant allows).
  useEffect(() => {
    if (!config || !selectedUser) return;
    const row = config.allowlists.find((r) => r.userId === selectedUser);
    if (row) {
      setAllowlistDraft(new Set(row.allowedIds));
      setPresetsAllowed(row.savedPresetsAllowed);
    } else {
      setAllowlistDraft(new Set(allowanceDraft));
      setPresetsAllowed(true);
    }
  }, [config, selectedUser, allowanceDraft]);

  const refreshContext = async () => {
    invalidatePlatformContext();
    await fetchPlatformContext(true);
  };

  const reload = async () => {
    const loaded = await fetchNavAdminConfig();
    setConfig(loaded);
    setPersonaDraft(
      Object.fromEntries(
        loaded.personaDefaults.map((row) => [row.persona, row.presetKey]),
      ),
    );
  };

  if (loading || !platformContext) {
    return (
      <PageSection>
        <Spinner label="Loading nav access config…" />
      </PageSection>
    );
  }
  if (error || !config) {
    return (
      <PageSection>
        <Notice tone="danger">
          {error ?? "Nav access config is unavailable."}
        </Notice>
      </PageSection>
    );
  }
  if (!isAdmin) {
    return (
      <PageSection>
        <Notice tone="info">
          Nav &amp; Menu Access is managed by your platform and tenant
          admins. Your menu follows the preset and allowance they set for
          you.
        </Notice>
      </PageSection>
    );
  }

  const allowanceRow = config.allowances.find(
    (r) => r.tenantId === selectedTenant,
  );

  const saveAllowance = async () => {
    if (!selectedTenant) return;
    setSaving("allowance");
    try {
      await saveTenantAllowance(selectedTenant, [...allowanceDraft]);
      await refreshContext();
      await reload();
      toast.success("Tenant allowance saved.");
    } catch (err) {
      toast.danger(err instanceof Error ? err.message : "Failed to save the allowance.");
    } finally {
      setSaving(null);
    }
  };

  const saveAllowlist = async () => {
    if (!selectedUser) return;
    setSaving("allowlist");
    try {
      await saveUserAllowlist(selectedUser, {
        tenantId: isPlatformAdmin ? selectedTenant ?? undefined : undefined,
        allowedIds: [...allowlistDraft],
        savedPresetsAllowed: presetsAllowed,
      });
      await refreshContext();
      await reload();
      toast.success("User allow-list saved.");
    } catch (err) {
      toast.danger(err instanceof Error ? err.message : "Failed to save the allow-list.");
    } finally {
      setSaving(null);
    }
  };

  const savePersona = async (personaKey: NavPersona) => {
    const presetKey = personaDraft[personaKey];
    if (!presetKey) return;
    setSaving(`persona:${personaKey}`);
    try {
      await savePersonaDefault(personaKey, presetKey);
      await refreshContext();
      await reload();
      toast.success(`Default preset for ${personaKey} saved.`);
    } catch (err) {
      toast.danger(err instanceof Error ? err.message : "Failed to save the default.");
    } finally {
      setSaving(null);
    }
  };

  const resetPersona = async (personaKey: NavPersona) => {
    setSaving(`persona:${personaKey}`);
    try {
      await resetPersonaDefault(personaKey);
      await refreshContext();
      await reload();
      toast.success(`Default preset for ${personaKey} reset to the shipped one.`);
    } catch (err) {
      toast.danger(err instanceof Error ? err.message : "Failed to reset the default.");
    } finally {
      setSaving(null);
    }
  };

  const addTypedUser = () => {
    const id = typedUserId.trim();
    if (!id) return;
    setSelectedUser(id);
    setTypedUserId("");
  };

  return (
    <PageSection>
      <Stack gap="3">
        <CardHeader
          title="Nav & Menu Access"
          subtitle="Who sees which menu items, per tenant and per user. A tenant never sees more than its allowance; a user never sees more than their allow-list. Admins always see the full menu."
        />
        <Notice tone="info">
          {isPlatformAdmin
            ? "Platform admin: allowances cap every tenant, allow-lists cap individual users, and persona defaults set the preset each persona starts from."
            : "Tenant admin: you can narrow per-user allow-lists for your own tenant's users only. The server refuses anything wider than your tenant's allowance."}
        </Notice>

        <Card>
          <Stack gap="3">
            <CardHeader
              title="Tenant allowance"
              subtitle={
                allowanceRow
                  ? `Last updated ${new Date(allowanceRow.updatedAtMs).toLocaleString()} by ${allowanceRow.updatedBy}.`
                  : "No allowance stored — the tenant gets everything the platform enables."
              }
            />
            {isPlatformAdmin ? (
              <Select
                label="Tenant"
                value={selectedTenant ?? ""}
                onChange={(event) => setSelectedTenant(event.target.value || null)}
              >
                {tenantIds.map((id) => (
                  <option key={id} value={id}>
                    {id}
                  </option>
                ))}
              </Select>
            ) : (
              <Notice tone="info">Tenant: {selectedTenant}</Notice>
            )}
            <NavIdCheckboxes
              value={allowanceDraft}
              disabled={!isPlatformAdmin}
              onChange={setAllowanceDraft}
            />
            {isPlatformAdmin && (
              <Button
                onClick={saveAllowance}
                loading={saving === "allowance"}
                disabled={!selectedTenant}
              >
                Save allowance
              </Button>
            )}
          </Stack>
        </Card>

        <Card>
          <Stack gap="3">
            <CardHeader
              title="Per-user allow-list"
              subtitle="Narrow one user below the tenant allowance. Saved presets can be switched off for the user as well."
            />
            {memberUserIds.length === 0 ? (
              <EmptyState
                title="No users in this tenant yet"
                description="Add a user by id below, or pick a tenant with members."
              />
            ) : (
              <Select
                label="User"
                value={selectedUser ?? ""}
                onChange={(event) => setSelectedUser(event.target.value || null)}
              >
                <option value="">Select a user…</option>
                {memberUserIds.map((id) => (
                  <option key={id} value={id}>
                    {id}
                  </option>
                ))}
              </Select>
            )}
            <Stack gap="2">
              <TextInput
                label="Add a user by id"
                value={typedUserId}
                placeholder="user id"
                onChange={(event) => setTypedUserId(event.target.value)}
              />
              <Button
                variant="secondary"
                onClick={addTypedUser}
                disabled={!typedUserId.trim()}
              >
                Add user
              </Button>
            </Stack>
            {selectedUser && (
              <>
                <Checkbox
                  label="User may use saved presets"
                  checked={presetsAllowed}
                  onChange={(event) => setPresetsAllowed(event.target.checked)}
                />
                <NavIdCheckboxes
                  value={allowlistDraft}
                  disabled={false}
                  onChange={setAllowlistDraft}
                />
                <Button
                  onClick={saveAllowlist}
                  loading={saving === "allowlist"}
                >
                  Save allow-list
                </Button>
              </>
            )}
          </Stack>
        </Card>

        <Card>
          <Stack gap="3">
            <CardHeader
              title="Persona defaults"
              subtitle="The preset each persona starts from. Takes effect on the user's next load."
            />
            {NAV_PERSONAS.map((personaKey) => {
              const row = config.personaDefaults.find(
                (r) => r.persona === personaKey,
              );
              return (
                <Stack key={personaKey} gap="2">
                  <Select
                    label={personaKey}
                    hint={
                      row?.overridden
                        ? "Overridden by an admin."
                        : "Shipped default."
                    }
                    value={personaDraft[personaKey] ?? ""}
                    disabled={!isPlatformAdmin}
                    onChange={(event) =>
                      setPersonaDraft((prev) => ({
                        ...prev,
                        [personaKey]: event.target.value,
                      }))
                    }
                  >
                    {builtinPresetKeys().map((key) => (
                      <option key={key} value={key}>
                        {NAV_PRESET_LABELS[key as keyof typeof NAV_PRESET_LABELS] ?? key}
                      </option>
                    ))}
                  </Select>
                  {isPlatformAdmin && (
                    <Stack gap="2">
                      <Button
                        variant="secondary"
                        onClick={() => savePersona(personaKey)}
                        loading={saving === `persona:${personaKey}`}
                      >
                        Save default
                      </Button>
                      <Button
                        variant="secondary"
                        onClick={() => resetPersona(personaKey)}
                        loading={saving === `persona:${personaKey}`}
                        disabled={!row?.overridden}
                      >
                        Reset to shipped default
                      </Button>
                    </Stack>
                  )}
                </Stack>
              );
            })}
          </Stack>
        </Card>
      </Stack>
    </PageSection>
  );
}
