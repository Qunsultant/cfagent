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
 *
 * Issue #4988 (#945 Q10): the section also renders the
 * provisioning checklist (#1764) — the brokerage-token item names
 * whether a stored E*TRADE token exists for the service identity —
 * and the "Authorize service login with E*TRADE" action, which
 * starts the 3-legged flow for the service login (the owner logs
 * in at E*TRADE as the service login, then pastes the verifier PIN
 * here). The owner's own Connect flow is untouched.
 */

import { useCallback, useEffect, useState } from "react";
import { Button, Flex, Notice, Spinner, Stack, TextInput } from "./components/ui";
import {
  completeServiceEtradeAuth,
  fetchServiceUserStatus,
  provisionPlatformTier,
  revokeServiceEtradeToken,
  startServiceEtradeAuth,
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
const STEP_UP_STALE =
  "Step-up authentication required: please sign in again and retry.";

function statusOf(err: unknown): number {
  return typeof (err as { status?: unknown } | null)?.status === "number"
    ? (err as { status: number }).status
    : 0;
}

function errorText(err: unknown): string {
  return err instanceof Error ? err.message : "Request failed.";
}

export function ServiceUserSection() {
  const [status, setStatus] = useState<ServiceUserStatus | null>(null);
  const [loading, setLoading] = useState(true);
  const [loadError, setLoadError] = useState("");
  const [notice, setNotice] = useState<NoticeState | null>(null);
  const [provisioning, setProvisioning] = useState(false);
  // Issue #4988: the service-login E*TRADE authorization flow.
  const [authorizing, setAuthorizing] = useState(false);
  const [authUrl, setAuthUrl] = useState<string | null>(null);
  const [verifier, setVerifier] = useState("");
  const [completing, setCompleting] = useState(false);
  const [revoking, setRevoking] = useState(false);

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

  /** Issue #4988: map an authorization failure onto the notice, never a silent button. */
  const authFailureNotice = useCallback((err: unknown): NoticeState => {
    const code = statusOf(err);
    if (code === 401) return { tone: "danger", text: NOT_SIGNED_IN };
    if (code === 403) {
      const text = errorText(err);
      if (/step-up/i.test(text)) return { tone: "danger", text: STEP_UP_STALE };
      return { tone: "danger", text: NOT_PLATFORM_ADMIN };
    }
    return { tone: "danger", text: errorText(err) };
  }, []);

  const authorize = useCallback(async () => {
    setAuthorizing(true);
    setNotice(null);
    try {
      const started = await startServiceEtradeAuth();
      setAuthUrl(started.authorizeUrl);
      // The URL is also rendered as a link below, so a blocked
      // popup never strands the owner (the #3197 lesson).
      if (typeof window !== "undefined" && typeof window.open === "function") {
        try {
          window.open(started.authorizeUrl, "_blank", "noopener");
        } catch {
          /* popup blocked; the rendered link is the fallback */
        }
      }
      setNotice({
        tone: "info",
        text:
          "Opened the E*TRADE authorization page. Log in at E*TRADE as the " +
          `service login (${started.serviceUser}), then paste the verifier PIN below.`,
      });
    } catch (err: unknown) {
      setNotice(authFailureNotice(err));
    } finally {
      setAuthorizing(false);
    }
  }, [authFailureNotice]);

  const completeAuthorization = useCallback(async () => {
    if (!verifier.trim()) {
      setNotice({ tone: "warning", text: "Paste the verifier PIN shown by E*TRADE first." });
      return;
    }
    setCompleting(true);
    setNotice(null);
    try {
      await completeServiceEtradeAuth(verifier.trim());
      setNotice({
        tone: "success",
        text: "Service login authorized with E*TRADE. The brokerage-token checklist item should now pass.",
      });
      setAuthUrl(null);
      setVerifier("");
      await loadStatus();
    } catch (err: unknown) {
      setNotice(authFailureNotice(err));
    } finally {
      setCompleting(false);
    }
  }, [verifier, loadStatus, authFailureNotice]);

  const revokeToken = useCallback(async () => {
    setRevoking(true);
    setNotice(null);
    try {
      const deleted = await revokeServiceEtradeToken();
      setNotice({
        tone: "success",
        text: deleted
          ? "Service login token revoked. Unattended E*TRADE work stops; the owner's token is untouched."
          : "No stored service-login token was found; nothing was deleted.",
      });
      await loadStatus();
    } catch (err: unknown) {
      setNotice(authFailureNotice(err));
    } finally {
      setRevoking(false);
    }
  }, [loadStatus, authFailureNotice]);

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

  const brokerageItem = status.provisioning?.checklist.find(
    (item) => item.id === "brokerage_token_present",
  );
  const tokenPresent = brokerageItem?.status === "pass";

  return (
    <>
      {/* Issue #4839 G4: the section explains itself before the button. */}
      <p className="ui-meta">
        The service user is the platform&apos;s own identity for background work. The
        platform tier is the set of admin roles it holds; Provision creates that tier
        the first time — only a status read showing it provisioned counts as done.
      </p>
      <Flex gap="6" wrap>
        <Stack gap="1">
          <span className="ui-meta">Service user</span>
          <strong>{status.serviceUser}</strong>
        </Stack>
        <Stack gap="1">
          <span className="ui-meta">Platform tier</span>
          <strong>
            {status.platform
              ? `Provisioned (${status.platform.roles.join(", ")})`
              : "Not provisioned"}
          </strong>
        </Stack>
        <Stack gap="1">
          <span className="ui-meta">Tenant tiers</span>
          <strong>{status.tenants.length > 0 ? status.tenants.join(", ") : "None"}</strong>
        </Stack>
      </Flex>
      {notice && <Notice tone={notice.tone}>{notice.text}</Notice>}
      <Button type="button" disabled={provisioning} onClick={() => void provision()}>
        Provision platform tier
      </Button>{" "}
      <Button type="button" variant="secondary" onClick={() => void loadStatus()}>
        Refresh status
      </Button>
      {status.provisioning && (
        <>
          <p className="ui-meta">
            Provisioning checklist — every item names the owner action that closes it.
          </p>
          <ul>
            {status.provisioning.checklist.map((item) => (
              <li key={item.id}>
                <strong>{item.label}:</strong>{" "}
                {item.status === "pass"
                  ? "Pass"
                  : item.status === "fail"
                    ? "Fail"
                    : "Unknown"}
                {item.detail ? ` — ${item.detail}` : ""}
              </li>
            ))}
          </ul>
          {status.provisioning.ownerActions.length > 0 && (
            <p className="ui-meta">
              {status.provisioning.ownerActions.join(" ")}
            </p>
          )}
          <Button type="button" disabled={authorizing} onClick={() => void authorize()}>
            Authorize service login with E*TRADE
          </Button>{" "}
          {tokenPresent && (
            <Button
              type="button"
              variant="secondary"
              disabled={revoking}
              onClick={() => void revokeToken()}
            >
              Revoke service login token
            </Button>
          )}
          {authUrl && (
            <>
              <p className="ui-meta">
                If the authorization page did not open, use this link:{" "}
                <a href={authUrl} target="_blank" rel="noopener noreferrer">
                  Authorize {status.serviceUser} at E*TRADE
                </a>
              </p>
              <TextInput
                label="Verifier PIN from E*TRADE"
                hint="Shown by E*TRADE after you log in as the service login."
                value={verifier}
                onChange={(event) => setVerifier(event.target.value)}
              />{" "}
              <Button
                type="button"
                disabled={completing || !verifier.trim()}
                onClick={() => void completeAuthorization()}
              >
                Complete authorization
              </Button>
            </>
          )}
        </>
      )}
    </>
  );
}
