/**
 * Issue #4585 — the SecurityHub home.
 *
 * The ONE security surface (`?tab=security-hub`, inventory §8.3 pattern):
 * it renders directly from the shell (`Chat.tsx` `TAB_CONTENT`), NOT
 * through the Platform Admin page — the moved sections live in their own
 * hub now. Its views are the sub-route scheme in `securityHubView.ts`:
 * iaaa-admin (IaaaAdminPanel), users (UserAdminPanel), admin-access
 * (AdminAccessSection, with its request state), profile (ProfileSection),
 * pdp (PdpPanel, issue #4651), pep (PepPanel, issue #4653), pip
 * (PipPanel, issue #4655), pap (PolicyProposalsPanel, issue 4658 —
 * moved here from the IAAA Admin Overview).
 *
 * View state follows the URL (`?view=`), the same pattern as
 * PlatformAdminPage and SchedulesHome: the component re-reads the URL on
 * every route change, and a tab click navigates through `navigateToTab`,
 * so back/forward, bookmarks, and reloads all land on the same view.
 * Inactive views unmount (TabPanel default).
 */
import { useCallback, useEffect, useState } from "react";
import { Card, PageShell, Tabs, TabPanel, type TabOption } from "./components/ui";
import { IaaaAdminPanel } from "./IaaaAdminPanel";
import { UserAdminPanel } from "./UserAdminPanel";
import { ProfileSection } from "./ProfileSection";
import { PdpPanel } from "./PdpPanel";
import { PepPanel } from "./PepPanel";
import { PipPanel } from "./PipPanel";
import { PolicyProposalsPanel } from "./PolicyProposalsPanel";
import {
  AdminAccessSection,
  type PlatformAdminUser,
} from "./PlatformAdminPanel";
import { navigateToTab, subscribeToRouteChanges } from "./router";
import { csrfHeaders } from "./apiFetch";
import {
  SECURITY_HUB_VIEW_LABELS,
  SECURITY_HUB_VIEWS,
  parseSecurityHubDeepLink,
  type SecurityHubDeepLink,
  type SecurityHubView,
} from "./securityHubView";

const SECURITY_HUB_TABS: TabOption<SecurityHubView>[] = SECURITY_HUB_VIEWS.map((id) => ({
  id,
  label: SECURITY_HUB_VIEW_LABELS[id],
}));

export interface SecurityHubHomeProps {
  userLogin?: string;
  user?: PlatformAdminUser;
}

export function SecurityHubHome({ userLogin, user }: SecurityHubHomeProps = {}) {
  const [deepLink, setDeepLink] = useState<SecurityHubDeepLink>(() =>
    typeof window !== "undefined"
      ? parseSecurityHubDeepLink(window.location.search)
      : { view: "iaaa-admin" },
  );

  // The admin-access request state, moved here from PlatformAdminPage
  // with the section it belongs to (issue #4585).
  const [requesting, setRequesting] = useState(false);
  const [accessStatus, setAccessStatus] = useState("");

  useEffect(() => {
    return subscribeToRouteChanges(() => {
      if (typeof window !== "undefined") {
        setDeepLink(parseSecurityHubDeepLink(window.location.search));
      }
    });
  }, []);

  const handleSelectView = (nextView: SecurityHubView) => {
    navigateToTab("security-hub", nextView);
  };

  const requestAdminAccess = useCallback(async () => {
    setRequesting(true);
    setAccessStatus("");
    try {
      const res = await globalThis.fetch("/api/iaaa/access-request", {
        method: "POST",
        headers: { "Content-Type": "application/json", ...csrfHeaders() },
        body: JSON.stringify({ requestedRole: "tenant-admin" }),
      });
      const data = (await res.json().catch(() => ({}))) as { error?: string };
      if (res.status === 201) {
        setAccessStatus("Access requested — pending admin approval.");
      } else if (res.status === 409) {
        setAccessStatus("You already have a pending access request.");
      } else {
        setAccessStatus(data.error || "Access request was not submitted.");
      }
    } catch {
      setAccessStatus("Access request was not submitted.");
    } finally {
      setRequesting(false);
    }
  }, []);

  return (
    <PageShell
      title="SecurityHub"
      scopeNote="IAAA admin, users, admin access, your profile, the Policy Decision Point, the Policy Enforcement Point, the Policy Information Point, and the Policy Administration Point"
    >
      <div className="security-hub-tabs-wrapper">
        <Tabs<SecurityHubView>
          idBase="security-hub"
          ariaLabel="SecurityHub views"
          tabs={SECURITY_HUB_TABS}
          value={deepLink.view}
          onChange={handleSelectView}
        />
      </div>

      <TabPanel idBase="security-hub" tabId="iaaa-admin" active={deepLink.view === "iaaa-admin"}>
        <Card>
          <div className="section-label-row">
            <span>IAAA Admin</span>
            <small>Read-only memberships, genesis &amp; audit</small>
          </div>
          <IaaaAdminPanel />
        </Card>
      </TabPanel>

      <TabPanel idBase="security-hub" tabId="users" active={deepLink.view === "users"}>
        <Card>
          <div className="section-label-row">
            <span>Users</span>
            <small>User profiles, tenant memberships &amp; account linkage</small>
          </div>
          <UserAdminPanel />
        </Card>
      </TabPanel>

      <TabPanel idBase="security-hub" tabId="admin-access" active={deepLink.view === "admin-access"}>
        <Card>
          <AdminAccessSection
            requesting={requesting}
            status={accessStatus}
            onRequest={() => void requestAdminAccess()}
            user={user}
          />
        </Card>
      </TabPanel>

      <TabPanel idBase="security-hub" tabId="profile" active={deepLink.view === "profile"}>
        <Card>
          <div className="section-label-row">
            <span>Profile</span>
            <small>Your display name and phone</small>
          </div>
          {userLogin ? <ProfileSection userLogin={userLogin} /> : null}
        </Card>
      </TabPanel>

      <TabPanel idBase="security-hub" tabId="pdp" active={deepLink.view === "pdp"}>
        <Card>
          <div className="section-label-row">
            <span>PDP</span>
            <small>Live policy state: active snapshot, source &amp; obligations</small>
          </div>
          <PdpPanel />
        </Card>
      </TabPanel>

      <TabPanel idBase="security-hub" tabId="pep" active={deepLink.view === "pep"}>
        <Card>
          <div className="section-label-row">
            <span>PEP</span>
            <small>Live enforcement state: gated routes, enforcement &amp; grace</small>
          </div>
          <PepPanel />
        </Card>
      </TabPanel>

      <TabPanel idBase="security-hub" tabId="pip" active={deepLink.view === "pip"}>
        <Card>
          <div className="section-label-row">
            <span>PIP</span>
            <small>Live attribute state: schema, sources &amp; your attributes</small>
          </div>
          <PipPanel />
        </Card>
      </TabPanel>

      <TabPanel idBase="security-hub" tabId="pap" active={deepLink.view === "pap"}>
        <Card>
          <div className="section-label-row">
            <span>PAP</span>
            <small>Live policy administration: proposals, preview, approval &amp; promotion</small>
          </div>
          <PolicyProposalsPanel />
        </Card>
      </TabPanel>
    </PageShell>
  );
}
