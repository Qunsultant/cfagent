/**
 * Issue #3261 — profile section: display name + phone, self-service.
 *
 * Built ONLY from src/client/components/ui/ primitives with
 * token-only styling (ux-architecture §20): no bespoke classes, no
 * inline styles.
 *
 * Display name and phone are the only editable fields. The login
 * is shown read-only (it IS the verified identity). Email is not
 * editable here: changing the sign-in email touches IAAA / session
 * / auth and needs CISO review first (#3261 comment 6681436382,
 * refs #945) — the section says so in one fixed line instead of
 * offering a field that goes nowhere.
 *
 * Phone is an UNVERIFIED contact field: the hint says so, and it
 * is never used for sign-in. Input length hints come from
 * PROFILE_LIMITS (config/profile-limits.json, single source of
 * truth); the server is the authority at validation time.
 *
 * AOP (#1969 program): every message the section renders comes
 * from the server's coded response — the save confirmation, the
 * duplicate notice, the load/save failures, and the field errors
 * (a 400 carries the failing field; the section marks that field
 * with the TextInput error prop, which sets aria-invalid and the
 * described-by error text). No hand-written variant per channel,
 * no raw error text. Notice tones announce via role="status"
 * (success/info) or role="alert" (danger) from the primitive.
 *
 * Idempotent Receiver (standards §7.2): one idempotency key per
 * save attempt, kept across retries of that attempt (a retry after
 * a lost response converges with 409 instead of writing twice)
 * and cleared once the save lands.
 */
import React, { useEffect, useRef, useState } from "react";
import { Button, Card, Notice, Spinner, Stack, TextInput } from "./components/ui";
import { PROFILE_LIMITS } from "../config/profileLimits";
import {
  displayNameFor,
  fetchProfile,
  newIdempotencyKey,
  ProfileApiError,
  saveProfile,
  type UserProfileView,
} from "./profileApi";

export interface ProfileSectionProps {
  /** Session login, shown read-only; the server is the authority. */
  userLogin: string;
}

type FieldErrors = { displayName?: string; phone?: string };

export function ProfileSection({ userLogin }: ProfileSectionProps) {
  const [profile, setProfile] = useState<UserProfileView | null>(null);
  const [loading, setLoading] = useState(true);
  const [loadError, setLoadError] = useState<string | null>(null);
  const [displayName, setDisplayName] = useState("");
  const [phone, setPhone] = useState("");
  const [saving, setSaving] = useState(false);
  const [saveError, setSaveError] = useState<string | null>(null);
  const [fieldErrors, setFieldErrors] = useState<FieldErrors>({});
  const [savedMessage, setSavedMessage] = useState<string | null>(null);
  const [savedDuplicate, setSavedDuplicate] = useState(false);
  const pendingKey = useRef<string | null>(null);

  const load = async () => {
    setLoading(true);
    setLoadError(null);
    try {
      const found = await fetchProfile();
      setProfile(found);
      setDisplayName(found.displayName ?? "");
      setPhone(found.phone ?? "");
    } catch (err) {
      setLoadError(
        err instanceof ProfileApiError
          ? err.message
          : "Your profile could not be loaded. Check your connection and try again.",
      );
    } finally {
      setLoading(false);
    }
  };

  useEffect(() => {
    void load();
    // Load once on mount: the profile is the caller's own row.
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, []);

  const save = async () => {
    setSaving(true);
    setSaveError(null);
    setFieldErrors({});
    setSavedMessage(null);
    setSavedDuplicate(false);
    if (!pendingKey.current) pendingKey.current = newIdempotencyKey();
    try {
      const result = await saveProfile(
        {
          displayName: displayName.trim() ? displayName.trim() : null,
          phone: phone.trim() ? phone.trim() : null,
        },
        pendingKey.current,
      );
      pendingKey.current = null;
      setProfile(result.profile);
      setDisplayName(result.profile.displayName ?? "");
      setPhone(result.profile.phone ?? "");
      setSavedMessage(result.message);
      setSavedDuplicate(result.duplicate);
    } catch (err) {
      // The key is kept: a retry re-sends the same key, so a lost
      // response converges with 409 instead of writing twice.
      if (err instanceof ProfileApiError && err.field === "displayName") {
        setFieldErrors({ displayName: err.message });
      } else if (err instanceof ProfileApiError && err.field === "phone") {
        setFieldErrors({ phone: err.message });
      } else {
        setSaveError(
          err instanceof ProfileApiError
            ? err.message
            : "Your profile could not be saved. Try again later.",
        );
      }
    } finally {
      setSaving(false);
    }
  };

  if (loading) {
    return (
      <Card>
        <Spinner label="Loading your profile" />
      </Card>
    );
  }

  if (loadError || profile === null) {
    return (
      <Card>
        <Notice tone="danger">{loadError ?? "Your profile could not be loaded."}</Notice>
        <Button type="button" variant="secondary" onClick={() => void load()}>
          Try again
        </Button>
      </Card>
    );
  }

  return (
    <Card>
      <Stack gap="2">
        <p>
          Signed in as: <strong>{userLogin}</strong>
          {profile.displayName ? ` — showing as ${displayNameFor(profile)}` : ""}
        </p>
        <TextInput
          label="Display name"
          hint="Shown instead of your login. Leave empty to show your login."
          value={displayName}
          maxLength={PROFILE_LIMITS.displayNameMaxLength}
          error={fieldErrors.displayName}
          onChange={(event) => setDisplayName(event.target.value)}
        />
        <TextInput
          label="Phone"
          hint="Optional. Used only to contact you about your account — never for sign-in, and not verified."
          value={phone}
          maxLength={PROFILE_LIMITS.phoneMaxLength}
          inputMode="tel"
          error={fieldErrors.phone}
          onChange={(event) => setPhone(event.target.value)}
        />
        <p>
          Email cannot be changed here yet — changing the sign-in email needs a
          security review first.
        </p>
        {saveError && <Notice tone="danger">{saveError}</Notice>}
        {savedMessage && (
          <Notice tone={savedDuplicate ? "info" : "success"}>{savedMessage}</Notice>
        )}
        <div>
          <Button type="button" variant="primary" disabled={saving} onClick={() => void save()} loading={saving}>
            Save profile
          </Button>
        </div>
      </Stack>
    </Card>
  );
}
