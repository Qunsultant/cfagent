/**
 * Issue #2471 (program #2468, Phase 1) — notification preferences panel.
 *
 * A panel surface calling the EXISTING lifecycle preferences route (no
 * new port, no new route). It takes the server-derived identity as a
 * prop — it never re-derives userId/tenantId from a claim — and renders
 * only from src/client/components/ui/ primitives with token-only
 * styling. Security mail is NOT a toggle here: it is non-suppressible
 * and no toggle on this panel can silence it (#1076 A3).
 *
 * The panel is composed into the first-run screen's preferences step
 * (its reachable surface); it is also usable standalone wherever a
 * preferences surface is mounted later. When the identity has no
 * account tenant, the route cannot serve preferences (it requires a
 * tenantId), so the panel says so plainly and offers Continue instead
 * of fabricating a tenant or saving against a guessed one.
 */
import React, { useCallback, useEffect, useState } from "react";
import { Button, Card, Checkbox, FieldShell, Notice, Spinner } from "./components/ui";
import {
  fetchNotificationPreferences,
  saveNotificationPreferences,
  type NotificationPreferences,
  type PlatformIdentityView,
} from "./firstRunApi";

export interface NotificationPreferencesPanelProps {
  /** Server-derived identity (from the #2219 endpoint), never a claim. */
  identity: PlatformIdentityView;
  /** Called after a successful save (first-run advances to completion). */
  onSaved?: () => void;
  /** Called when the user continues without saving (or without an account). */
  onContinue?: () => void;
}

export function NotificationPreferencesPanel({
  identity,
  onSaved,
  onContinue,
}: NotificationPreferencesPanelProps) {
  const [prefs, setPrefs] = useState<NotificationPreferences | null>(null);
  const [loading, setLoading] = useState(false);
  const [loadError, setLoadError] = useState(false);
  const [saving, setSaving] = useState(false);
  const [saveError, setSaveError] = useState(false);
  const [saved, setSaved] = useState(false);

  const load = useCallback(async () => {
    if (identity.tenantId === null) return;
    setLoading(true);
    setLoadError(false);
    try {
      setPrefs(await fetchNotificationPreferences(identity.userLogin, identity.tenantId));
    } catch {
      setLoadError(true);
    } finally {
      setLoading(false);
    }
  }, [identity.userLogin, identity.tenantId]);

  useEffect(() => {
    void load();
  }, [load]);

  if (identity.tenantId === null) {
    return (
      <Card>
        <Notice tone="info">
          Notification preferences need an account. Your account is not set up
          yet, so preferences cannot be saved right now — you can finish
          setup and set them later once your account is ready.
        </Notice>
        {onContinue && (
          <Button type="button" variant="primary" onClick={onContinue}>
            Continue
          </Button>
        )}
      </Card>
    );
  }

  if (loading) {
    return (
      <Card>
        <Spinner label="Loading notification preferences" />
      </Card>
    );
  }

  if (loadError || prefs === null) {
    return (
      <Card>
        <Notice tone="danger">
          Notification preferences could not be loaded. Try again, or continue
          without changing them.
        </Notice>
        <Button type="button" variant="secondary" onClick={() => void load()}>
          Try again
        </Button>{" "}
        {onContinue && (
          <Button type="button" variant="primary" onClick={onContinue}>
            Continue
          </Button>
        )}
      </Card>
    );
  }

  const save = async () => {
    setSaving(true);
    setSaveError(false);
    setSaved(false);
    try {
      await saveNotificationPreferences({
        userId: identity.userLogin,
        tenantId: identity.tenantId as string,
        digestEnabled: prefs.digestEnabled,
        welcomeEnabled: prefs.welcomeEnabled,
      });
      setSaved(true);
      onSaved?.();
    } catch {
      setSaveError(true);
    } finally {
      setSaving(false);
    }
  };

  return (
    <Card>
      <p>Choose which notifications you receive. Security mail is always sent and cannot be turned off here.</p>
      {/* FieldShell (a ui primitive) owns the label: bare label elements
          would grow the #2177 bespoke-styling ceiling, which ratchets
          only down — so checkbox rows label through the primitive. */}
      <FieldShell id="notification-digest" label="Digest — a periodic summary of activity">
        <Checkbox
          id="notification-digest"
          name="digestEnabled"
          checked={prefs.digestEnabled}
          onChange={(e) => setPrefs({ ...prefs, digestEnabled: e.target.checked })}
        />
      </FieldShell>
      <FieldShell id="notification-welcome" label="Welcome — onboarding messages for new users">
        <Checkbox
          id="notification-welcome"
          name="welcomeEnabled"
          checked={prefs.welcomeEnabled}
          onChange={(e) => setPrefs({ ...prefs, welcomeEnabled: e.target.checked })}
        />
      </FieldShell>
      {saveError && (
        <Notice tone="danger">Preferences could not be saved. Try again.</Notice>
      )}
      {saved && !onSaved && <Notice tone="success">Saved.</Notice>}
      <Button type="button" variant="primary" disabled={saving} onClick={() => void save()} loading={saving}>
        {"Save"}
      </Button>{" "}
      {onContinue && (
        <Button type="button" variant="secondary" onClick={onContinue}>
          Continue without saving
        </Button>
      )}
    </Card>
  );
}
