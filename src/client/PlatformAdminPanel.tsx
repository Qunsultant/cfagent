import { NAV_ICON_MAP } from "./components/NavigationMenu";
/**
 * Platform Admin side panel (issue #2624, follow-up).
 *
 * @deprecated superseded by src/client/PlatformAdminPage.tsx
 *
 * The settings dropdown had grown to fourteen sections: everyday controls
 * mixed with nine administration surfaces at the bottom, plus the signed-in
 * account card. The administration half now lives here — a right-hand drawer
 * whose menu is externalized config (the #2529 LeftNavBar idiom):
 * `platformAdminConfig.ts` → sections → items.
 *
 * Entry point: the left-nav item "Platform Admin" and its sub-menu
 * (`platform-admin:<section>` ids). The nav shell opens this drawer at the
 * selected section; nothing here depends on the settings menu being mounted.
 *
 * The panel is self-contained: ad-banner preferences come from
 * `adBannerConfig` (localStorage, optional parent override) and the
 * request-admin-access action posts the same endpoint the settings menu used
 * to post. Styling follows docs/architecture/UX/ux-architecture.md §20 — primitives
 * and tokens only, no bespoke classes and no inline layout styles.
 */

import { useCallback, useEffect, useState } from "react";
import {
  Badge,
  Button,
  Card,
  CardHeader,
  Drawer,
  Flex,
  PageSection,
  PillGroup,
  Stack,
  Tabs,
  TabPanel,
  type TabOption,
} from "./components/ui";
import {
  getStoredAdBannerConfig,
  saveStoredAdBannerConfig,
  type AdBannerConfig,
} from "./adBannerConfig";
import { ApiKeysPanel } from "./ApiKeysPanel";
import {
  DEFAULT_PLATFORM_ADMIN_CONFIG,
  platformAdminItems,
  platformAdminTitle,
  type PlatformAdminConfig,
  type PlatformAdminMenuItemConfig,
  type PlatformAdminSectionId,
} from "./platformAdminConfig";

export type { PlatformAdminSectionId };

export interface PlatformAdminUser {
  login: string;
  name?: string;
  avatar?: string;
  providerName?: string;
}

export interface PlatformAdminPanelProps {
  open: boolean;
  onClose: () => void;
  /** Externalized menu config (#2529 idiom); defaults to the shipped config. */
  config?: PlatformAdminConfig;
  /** Section shown when the drawer opens; defaults to the first item. */
  initialSection?: string;
  /** Controlled ad-banner config (optional); defaults to the stored one. */
  adBannerConfig?: AdBannerConfig;
  onUpdateAdBannerConfig?: (config: AdBannerConfig) => void;
  onOpenPartnerDeals?: () => void;
  user?: PlatformAdminUser;
}

export function AdsSection({
  ads,
  onToggleMaster,
  onToggleOption,
  onOpenPartnerDeals,
}: {
  ads: AdBannerConfig;
  onToggleMaster: (enabled: boolean) => void;
  onToggleOption: (key: keyof Omit<AdBannerConfig, "enabled">, value: boolean) => void;
  onOpenPartnerDeals?: () => void;
}) {
  return (
    <PageSection>
      <CardHeader
        title="Ads & Partner Banners"
        meta={
          <span className="ui-meta-sm">
            {ads.enabled ? "Active (Customized)" : "Disabled (Clean Workspace)"}
          </span>
        }
      />

      <p className="ui-meta">
        Promotional banners and sponsor spotlights are externalized by default to keep workspace tabs clean.
        Toggle them on if desired, or browse deals on-demand.
      </p>

      <Flex align="center" justify="between" gap="2">
        <span className="ui-label">Workspace Banners:</span>
        <PillGroup
          ariaLabel="Workspace banners"
          size="sm"
          variant="default"
          options={[
            { id: "off", label: "OFF (Clean)", icon: "⏹", tooltip: "Disable all promotional banners and ads across workspace tabs (Clean UI)" },
            { id: "on", label: "ON", icon: "▶", tooltip: "Enable promotional banners and customize placements" },
          ]}
          value={ads.enabled ? "on" : "off"}
          onChange={(v) => onToggleMaster(v === "on")}
        />
      </Flex>

      {ads.enabled && (
        <Card padding="sm">
          <Stack gap="2">
            <Flex align="center" justify="between" gap="2">
              <span className="ui-label">Sponsor Spotlight:</span>
              <PillGroup
                ariaLabel="Sponsor Spotlight"
                size="sm"
                variant="default"
                options={[
                  { id: "off", label: "OFF" },
                  { id: "on", label: "ON" },
                ]}
                value={ads.showSponsorSpotlight ? "on" : "off"}
                onChange={(v) => onToggleOption("showSponsorSpotlight", v === "on")}
              />
            </Flex>

            <Flex align="center" justify="between" gap="2">
              <span className="ui-label">Ad Network Strip:</span>
              <PillGroup
                ariaLabel="Ad Network Strip"
                size="sm"
                variant="default"
                options={[
                  { id: "off", label: "OFF" },
                  { id: "on", label: "ON" },
                ]}
                value={ads.showAdNetworkStrip ? "on" : "off"}
                onChange={(v) => onToggleOption("showAdNetworkStrip", v === "on")}
              />
            </Flex>

            <Flex align="center" justify="between" gap="2">
              <span className="ui-label">Google Ad Units:</span>
              <PillGroup
                ariaLabel="Google Ad Units"
                size="sm"
                variant="default"
                options={[
                  { id: "off", label: "OFF" },
                  { id: "on", label: "ON" },
                ]}
                value={ads.showGoogleAdUnits ? "on" : "off"}
                onChange={(v) => onToggleOption("showGoogleAdUnits", v === "on")}
              />
            </Flex>
          </Stack>
        </Card>
      )}

      <Stack>
        <Button
          type="button"
          onClick={() => {
            if (onOpenPartnerDeals) {
              onOpenPartnerDeals();
            } else if (typeof window !== "undefined") {
              window.dispatchEvent(new CustomEvent("open-partner-deals-modal"));
            }
          }}
          title="Open external Partner Deals & Offers showcase"
        >
          ⭐ Browse Partner Deals &amp; Cloud Credits (External) ↗
        </Button>
      </Stack>
    </PageSection>
  );
}

export function ProvenanceSection() {
  return (
    <PageSection>
      <details open>
        <summary>
          <span>⚙️ Technical Diagnostics &amp; Provenance</span>
          <span aria-hidden="true">▾</span>
        </summary>
        <Stack gap="1" className="ui-meta-sm">
          <Flex align="center" gap="2" wrap>
            <strong>DID:</strong>
            <code className="ui-mono">did:agent:openaimp:trading</code>
          </Flex>
          <Flex align="center" gap="2" wrap>
            <strong>Architecture:</strong>
            <span>MCP &amp; OAuth 1.0a REST Client</span>
          </Flex>
          <Flex align="center" gap="2" wrap>
            <strong>Attestation:</strong>
            <span>Internal W3C DID Cryptographic Stamping</span>
          </Flex>
          <Flex align="center" gap="2" wrap>
            <strong>Ledger Architecture:</strong>
            <span>Institutional Execution Ledger &amp; Audit Trail</span>
          </Flex>
        </Stack>
      </details>
    </PageSection>
  );
}

export function AdminAccessSection({
  requesting,
  status,
  onRequest,
  user,
}: {
  requesting: boolean;
  status: string;
  onRequest: () => void;
  user?: PlatformAdminUser;
}) {
  const login = user?.login?.trim();
  // Never invent an identity: if the shell has no session user, say so
  // instead of printing "unknown" / "UN" / "@unknown" (issue #2624 fix-up).
  if (!login) {
    return (
      <PageSection>
        <CardHeader
          title="Request admin access"
          meta={<span className="ui-meta-sm">No signed-in identity</span>}
        />
        <p className="ui-meta">
          The session user is not available on this page, so an access request cannot be attributed.
          Reload the page after signing in and try again.
        </p>
      </PageSection>
    );
  }
  const initials = (user?.name || login).slice(0, 2).toUpperCase();
  return (
    <PageSection>
      <CardHeader
        title="Request admin access"
        meta={<span className="ui-meta-sm">Signed in as {login}</span>}
      />
      <Card padding="sm">
        <Flex align="center" gap="2">
          {user?.avatar ? (
            <img src={user.avatar} alt={login} width={28} height={28} />
          ) : (
            <Badge size="sm" tone="neutral">{initials}</Badge>
          )}
          <Stack gap="0">
            <strong>{user?.name || login}</strong>
            <span className="ui-meta-sm">@{login}</span>
            {user?.providerName && <span className="ui-meta-sm">Logged in via {user.providerName}</span>}
            <Button type="button" disabled={requesting} onClick={onRequest}>
              Request admin access
            </Button>
            {status && (
              <span className="ui-meta-sm" role="status">
                {status}
              </span>
            )}
          </Stack>
        </Flex>
      </Card>
    </PageSection>
  );
}

export function PlatformAdminPanel({
  open,
  onClose,
  config = DEFAULT_PLATFORM_ADMIN_CONFIG,
  initialSection,
  adBannerConfig,
  onUpdateAdBannerConfig,
  onOpenPartnerDeals,
  user,
}: PlatformAdminPanelProps) {
  const items = platformAdminItems(config);
  const firstItem = items[0];
  const [active, setActive] = useState<string>(initialSection ?? firstItem.id);
  const [ads, setAds] = useState<AdBannerConfig>(() => adBannerConfig ?? getStoredAdBannerConfig());

  // Ad preferences: parent-controlled when given, stored otherwise.
  useEffect(() => {
    if (adBannerConfig) setAds(adBannerConfig);
  }, [adBannerConfig]);

  const applyAds = useCallback(
    (next: AdBannerConfig) => {
      setAds(next);
      saveStoredAdBannerConfig(next);
      onUpdateAdBannerConfig?.(next);
    },
    [onUpdateAdBannerConfig],
  );

  const toggleMaster = useCallback((enabled: boolean) => applyAds({ ...ads, enabled }), [ads, applyAds]);
  const toggleOption = useCallback(
    (key: keyof Omit<AdBannerConfig, "enabled">, value: boolean) => applyAds({ ...ads, [key]: value }),
    [ads, applyAds],
  );

  // Opening the drawer always lands on the requested section (or the first
  // one), never on whatever was left selected in a previous turn.
  useEffect(() => {
    if (open) setActive(initialSection ?? firstItem.id);
  }, [open, initialSection, firstItem.id]);

  if (!open) return null;


  const tabOptions: TabOption<string>[] = items.map((section) => {
    const ItemIcon = section.icon ? NAV_ICON_MAP[section.icon] : null;
    return {
      id: section.id,
      label: section.label,
      ...(ItemIcon ? { icon: <ItemIcon active={active === section.id} /> } : {}),
    };
  });

  return (
    <Drawer
      open={open}
      onClose={onClose}
      title={platformAdminTitle(config)}
      ariaLabel="Platform Admin"
    >
      <Stack gap="3">
        <p className="ui-meta">Administration surfaces for this workspace</p>
        <Tabs
          tabs={tabOptions}
          value={active}
          onChange={setActive}
          ariaLabel="Platform Admin sections"
          idBase="platform-admin-drawer"
        />
        <TabPanel idBase="platform-admin-drawer" tabId="ads" active={active === "ads"}>
          <AdsSection
            ads={ads}
            onToggleMaster={toggleMaster}
            onToggleOption={toggleOption}
            {...(onOpenPartnerDeals ? { onOpenPartnerDeals } : {})}
          />
        </TabPanel>
        {/* Issue #4561: the last schedule outpost moved to the
            schedules home — `background-tasks` renders there as
            `?tab=schedules&view=background-tasks` (the async-jobs
            panel), and `scheduled-goals` / `jobs` left the
            platform-admin sub-menu with it (their panels were
            already folded into the home in #3121 S2, #4110). This
            drawer mounts no panels for any of the three; the
            retired addresses redirect to the home
            (legacySchedulesRedirect). */}
        <TabPanel
          idBase="platform-admin-drawer"
          tabId="provenance"
          active={active === "provenance"}
        >
          <ProvenanceSection />
        </TabPanel>
        <TabPanel
          idBase="platform-admin-drawer"
          tabId="api-keys"
          active={active === "api-keys"}
        >
          <PageSection>
            <CardHeader
              title="API Keys"
              meta={<span className="ui-meta-sm">MCP transport access for external clients</span>}
            />
            <ApiKeysPanel />
          </PageSection>
        </TabPanel>
        {items
          .filter((section) => !["ads", "provenance", "api-keys"].includes(section.id))
          .map((section) => (
            <TabPanel
              key={section.id}
              idBase="platform-admin-drawer"
              tabId={section.id}
              active={active === section.id}
            >
              {null}
            </TabPanel>
          ))}
        {/* Issue #4585: the data and security sections moved into
            their own hubs — `data-providers`, `data-lifecycle`, and
            `downloads` render in DataHub (`?tab=data-hub`);
            `iaaa-admin`, `users`, and `admin-access` render in
            SecurityHub (`?tab=security-hub`). This drawer mounts no
            panels for any of the six; the retired addresses redirect
            to the hubs (legacyPlatformAdminHubRedirect). */}
      </Stack>
    </Drawer>
  );
}

/** Section id the nav passes in (`platform-admin:api-keys` → `api-keys`). */
export function isPlatformAdminSectionId(value: unknown): value is PlatformAdminSectionId {
  if (typeof value !== 'string') return false;
  return DEFAULT_PLATFORM_ADMIN_CONFIG.sections[0].items.some((item) => item.id === value);
}
