/**
 * Issue #5160 — the IAAA Admin "Identity profile" section: the IDP
 * profile config (attribute set + retention) and the admin
 * identity lookup.
 *
 * Built ONLY from src/client/components/ui/ primitives with
 * token-only styling (ux-architecture §20): no bespoke classes, no
 * inline styles.
 *
 * Platform-admin only: the panel mounts under the platform-gated
 * IAAA Admin Overview, and the routes refuse non-admins with 403.
 * The config is audited server-side (field names only — the
 * exclusion list names attribute keys, never values). The lookup
 * is exact-match and returns ALL matches in scope, never a silent
 * winner: an ambiguous result is shown as such and no identity is
 * picked for the operator. Values are never rendered as lookup
 * results (ids + tenant + source only).
 */
import React, { useEffect, useState } from "react";
import { Button, CardHeader, Checkbox, Notice, Spinner, Stack, TextInput } from "./components/ui";
import {
  fetchIdpProfileConfig,
  lookupIdentityByAttribute,
  saveIdpProfileConfig,
  type IdpProfileConfigView,
  type IdpProfileLookupMatch,
} from "./idpProfileAdminApi";

export function IdpProfileConfigPanel() {
  const [config, setConfig] = useState<IdpProfileConfigView | null>(null);
  const [loading, setLoading] = useState(true);
  const [loadError, setLoadError] = useState<string | null>(null);
  const [storeAll, setStoreAll] = useState(true);
  const [excluded, setExcluded] = useState("");
  const [retentionDays, setRetentionDays] = useState("0");
  const [saving, setSaving] = useState(false);
  const [saveError, setSaveError] = useState<string | null>(null);
  const [savedMessage, setSavedMessage] = useState<string | null>(null);
  const [lookupAttribute, setLookupAttribute] = useState("email");
  const [lookupValue, setLookupValue] = useState("");
  const [lookupTenant, setLookupTenant] = useState("");
  const [lookingUp, setLookingUp] = useState(false);
  const [lookupError, setLookupError] = useState<string | null>(null);
  const [lookupMatches, setLookupMatches] = useState<IdpProfileLookupMatch[] | null>(null);
  const [lookupAmbiguous, setLookupAmbiguous] = useState(false);

  const load = async () => {
    setLoading(true);
    setLoadError(null);
    try {
      const found = await fetchIdpProfileConfig();
      setConfig(found);
      setStoreAll(found.storeAll);
      setExcluded(found.excludedAttributes.join(", "));
      setRetentionDays(String(found.retentionDays));
    } catch (err) {
      setLoadError(err instanceof Error ? err.message : "The identity profile config could not be loaded.");
    } finally {
      setLoading(false);
    }
  };

  useEffect(() => {
    void load();
  }, []);

  const save = async () => {
    setSaving(true);
    setSaveError(null);
    setSavedMessage(null);
    const days = Number(retentionDays);
    if (!Number.isInteger(days) || days < 0) {
      setSaveError("Retention must be a whole number of days, 0 or more.");
      setSaving(false);
      return;
    }
    const next: IdpProfileConfigView = {
      storeAll,
      excludedAttributes: excluded
        .split(",")
        .map((s) => s.trim())
        .filter((s) => s.length > 0),
      retentionDays: days,
    };
    try {
      const saved = await saveIdpProfileConfig(next);
      setConfig(saved);
      setStoreAll(saved.storeAll);
      setExcluded(saved.excludedAttributes.join(", "));
      setRetentionDays(String(saved.retentionDays));
      setSavedMessage("Identity profile config saved.");
    } catch (err) {
      setSaveError(err instanceof Error ? err.message : "The identity profile config could not be saved.");
    } finally {
      setSaving(false);
    }
  };

  const lookup = async () => {
    setLookingUp(true);
    setLookupError(null);
    setLookupMatches(null);
    setLookupAmbiguous(false);
    try {
      const result = await lookupIdentityByAttribute(
        lookupAttribute.trim(),
        lookupValue,
        lookupTenant.trim() || null,
      );
      setLookupMatches(result.matches);
      setLookupAmbiguous(result.ambiguous);
    } catch (err) {
      setLookupError(err instanceof Error ? err.message : "Identity lookup failed.");
    } finally {
      setLookingUp(false);
    }
  };

  if (loading) {
    return <Spinner label="Loading the identity profile config" />;
  }

  if (loadError || config === null) {
    return (
      <Stack gap="2">
        <Notice tone="danger">{loadError ?? "The identity profile config could not be loaded."}</Notice>
        <div>
          <Button type="button" variant="secondary" onClick={() => void load()}>
            Try again
          </Button>
        </div>
      </Stack>
    );
  }

  return (
    <Stack gap="4">
      <CardHeader title="Identity profile" />
      <p>
        IDP attributes captured at sign-in are stored as a durable, per-tenant user profile.
        The shipped default stores every attribute the provider sends; retention 0 keeps a
        profile while its identity exists.
      </p>
      <Checkbox
        label="Store all IDP attributes"
        checked={storeAll}
        onChange={(event) => setStoreAll(event.target.checked)}
      />
      <TextInput
        label="Excluded attributes"
        hint="Comma-separated IDP attribute names never stored (for example: locale). Token-like fields are always dropped."
        value={excluded}
        onChange={(event) => setExcluded(event.target.value)}
      />
      <TextInput
        label="Retention (days)"
        hint="Days to retain a profile after its identity's last sign-in. 0 keeps the profile while the identity exists."
        value={retentionDays}
        inputMode="numeric"
        onChange={(event) => setRetentionDays(event.target.value)}
      />
      {saveError && <Notice tone="danger">{saveError}</Notice>}
      {savedMessage && <Notice tone="success">{savedMessage}</Notice>}
      <div>
        <Button type="button" variant="primary" disabled={saving} onClick={() => void save()} loading={saving}>
          Save identity profile config
        </Button>
      </div>
      <CardHeader title="Identity lookup" />
      <p>
        Find an identity by a stored IDP attribute (email, phone, or any identifier). Exact
        match only — an ambiguous result names no winner.
      </p>
      <TextInput
        label="Attribute"
        hint="The IDP attribute name to match (for example: email)."
        value={lookupAttribute}
        onChange={(event) => setLookupAttribute(event.target.value)}
      />
      <TextInput
        label="Value"
        hint="The value as typed — the lookup normalizes email case and phone formatting itself."
        value={lookupValue}
        onChange={(event) => setLookupValue(event.target.value)}
      />
      <TextInput
        label="Tenant (optional)"
        hint="Leave empty to search all tenants (platform-admin only). A tenant-admin always searches their own tenant."
        value={lookupTenant}
        onChange={(event) => setLookupTenant(event.target.value)}
      />
      {lookupError && <Notice tone="danger">{lookupError}</Notice>}
      {lookupMatches !== null && !lookupAmbiguous && lookupMatches.length === 0 && (
        <Notice tone="info">No identity matches that attribute value.</Notice>
      )}
      {lookupAmbiguous && (
        <Notice tone="danger">
          More than one identity matches — the lookup is ambiguous. No identity was picked; narrow the search.
        </Notice>
      )}
      {lookupMatches !== null && lookupMatches.length > 0 && (
        <Stack gap="1">
          {lookupMatches.map((m) => (
            <p key={`${m.tenantId}:${m.internalUserId}`}>
              {m.internalUserId} — tenant {m.tenantId} — source {m.source}
            </p>
          ))}
        </Stack>
      )}
      <div>
        <Button
          type="button"
          variant="secondary"
          disabled={lookingUp || !lookupAttribute.trim() || !lookupValue.trim()}
          onClick={() => void lookup()}
          loading={lookingUp}
        >
          Look up identity
        </Button>
      </div>
    </Stack>
  );
}
