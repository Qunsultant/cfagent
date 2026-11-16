/**
 * Service-user section for the IAAA admin panel (issue #2501).
 *
 * Rendered on the Overview tab: like admin counts and genesis, the
 * service-user tiers are platform state, so the section lives with
 * them instead of growing a new tab (tab indices unchanged) and is
 * not duplicated in the Queue tab. The panel itself gates behind
 * the overview route, so non-admins never reach this section; its
 * own 401/403 handling is defense in depth, and a denied state
 * never renders a button that silently fails.
 *
 * Only a status read showing the platform tier provisioned counts
 * as done. A 202 provision outcome renders queued-not-done
 * guidance, never success; the admin re-checks status to prove it.
 */

import { useCallback, useEffect, useState } from "react";
import { Button, Notice, Spinner } from "./components/ui";
import {
  fetchServiceUserStatus,
  provisionPlatformTier,
  type ServiceUserStatus,
} from "./serviceUserApi";

type NoticeState = {
  tone: "success" | "warning" | "danger" | "info";
  text: string;
};

const NOT_SIGNED_IN = "Not signed in. Sign in with a platform-admin account and try again.";
const NOT_PLATFORM_ADMIN =
  "This login is not a platform admin. Service-user administration requires " +
  "platform-admin membership; if no login holds it, the first-admin bootstrap " +
  "question (issue 2429) is the blocker, not a retry.";

function statusOf(err: unknown): number {
  return typeof (err as { status?: unknown } | null)?.status === "number"
    ? (err as { status: number }).status
    : 0;
}

export function ServiceUserSection() {
  const [status, setStatus] = useState<ServiceUserStatus | null>(null);
  const [loading, setLoading] = useState(true);
  const [loadError, setLoadError] = useState("");
  const [notice, setNotice] = useState<NoticeState | null>(null);
  const [provisioning, setProvisioning] = useState(false);

  const loadStatus = useCallback(async () => {
    setLoading(true);
    setLoadError("");
    try {
      setStatus(await fetchServiceUserStatus());
    } catch (err: unknown) {
      const code = statusOf(err);
      if (code === 401) {
        setLoadError(NOT_SIGNED_IN);
      } else if (code === 403) {
        setLoadError(NOT_PLATFORM_ADMIN);
      } else {
        setLoadError(
          err instanceof Error ? err.message : "Failed to load service-user status.",
        );
      }
      setStatus(null);
    } finally {
      setLoading(false);
    }
  }, []);

  useEffect(() => {
    void loadStatus();
  }, [loadStatus]);

  const provision = useCallback(async () => {
    setProvisioning(true);
    setNotice(null);
    try {
      const outcome = await provisionPlatformTier();
      if (outcome.kind === "queued") {
        setNotice({
          tone: "warning",
          text:
            "Provisioning was queued as a background job, not completed. " +
            "Re-check status below: only a status read showing the platform " +
            "tier provisioned counts as done.",
        });
      } else if (outcome.kind === "alreadyProvisioned") {
        setNotice({ tone: "info", text: "Platform tier was already provisioned." });
        await loadStatus();
      } else {
        setNotice({ tone: "success", text: "Platform tier provisioned." });
        await loadStatus();
      }
    } catch (err: unknown) {
      const code = statusOf(err);
      if (code === 401) {
        setNotice({ tone: "danger", text: NOT_SIGNED_IN });
      } else if (code === 403) {
        setNotice({ tone: "danger", text: NOT_PLATFORM_ADMIN });
      } else {
        setNotice({
          tone: "danger",
          text: err instanceof Error ? err.message : "Failed to provision the platform tier.",
        });
      }
    } finally {
      setProvisioning(false);
    }
  }, [loadStatus]);

  if (loading) return <Spinner />;
  if (loadError) {
    return (
      <>
        <Notice tone="danger">{loadError}</Notice>{" "}
        <Button type="button" variant="secondary" onClick={() => void loadStatus()}>
          Refresh status
        </Button>
      </>
    );
  }
  if (!status) return null;

  return (
    <>
      {/* Issue #4839 G4: the section explains itself before the button. */}
      <p className="iaaa-admin-note">
        The service user is the platform&apos;s own identity for background work. The
        platform tier is the set of admin roles it holds; Provision creates that tier
        the first time — only a status read showing it provisioned counts as done.
      </p>
      <div className="iaaa-admin-summary">
        <div>
          <span className="iaaa-admin-label">Service user</span>
          <strong>{status.serviceUser}</strong>
        </div>
        <div>
          <span className="iaaa-admin-label">Platform tier</span>
          <strong>
            {status.platform
              ? `Provisioned (${status.platform.roles.join(", ")})`
              : "Not provisioned"}
          </strong>
        </div>
        <div>
          <span className="iaaa-admin-label">Tenant tiers</span>
          <strong>{status.tenants.length > 0 ? status.tenants.join(", ") : "None"}</strong>
        </div>
      </div>
      {notice && <Notice tone={notice.tone}>{notice.text}</Notice>}
      <Button type="button" disabled={provisioning} onClick={() => void provision()}>
        Provision platform tier
      </Button>{" "}
      <Button type="button" variant="secondary" onClick={() => void loadStatus()}>
        Refresh status
      </Button>
    </>
  );
}
