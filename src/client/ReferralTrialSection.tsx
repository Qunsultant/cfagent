/**
 * Issue #6141 — the referral panel in the Profile section. Every
 * signed-in user sees their own referral link, the share message,
 * their earned trial-extension days, their banked days, their
 * trial end date, and how many users they referred. The numbers
 * come from GET /referral/balance (the existing route, extended
 * server-side with the `extension` block) — no second route.
 * The link is the 2.27 `?ref=<login>` link (the same construction
 * as Chat's personalReferralUrl); the share message renders the
 * operator's template client-side. Copy uses navigator.clipboard
 * (ApiKeysPanel / Chat precedent). Failures render as fixed
 * strings keyed by HTTP status; server error bodies are never
 * rendered. ui primitives only, token-only styling.
 */
import React, { useCallback, useEffect, useState } from "react";
import { Button } from "./components/ui/Button";
import { Card } from "./components/ui/Card";
import { Notice } from "./components/ui/Notice";
import { TextInput } from "./components/ui/TextInput";
import {
  getReferralTrial,
  ReferralTrialApiError,
  type ReferralTrialView,
} from "./referralTrialApi";

function statusOf(error: unknown): number {
  return error instanceof ReferralTrialApiError ? error.status : 0;
}

function loadMessage(status: number): string {
  if (status === 503) return "The referral service is temporarily unavailable.";
  return "Your referral details could not be loaded.";
}

function renderShareMessage(template: string, trialDays: number, link: string): string {
  return template.replaceAll("{trialDays}", String(trialDays)).replaceAll("{link}", link);
}

export function ReferralTrialSection({ userLogin }: { userLogin: string }) {
  const [view, setView] = useState<ReferralTrialView | null>(null);
  const [loading, setLoading] = useState(true);
  const [loadError, setLoadError] = useState<string | null>(null);
  const [copied, setCopied] = useState(false);

  const load = useCallback(async () => {
    setLoading(true);
    setLoadError(null);
    try {
      setView(await getReferralTrial(userLogin));
    } catch (err) {
      setView(null);
      setLoadError(loadMessage(statusOf(err)));
    } finally {
      setLoading(false);
    }
  }, [userLogin]);

  useEffect(() => {
    let cancelled = false;
    load().catch(() => {
      if (!cancelled) setLoadError(loadMessage(0));
    });
    return () => {
      cancelled = true;
    };
  }, [load]);

  const referralLink =
    typeof window !== "undefined"
      ? `${window.location.origin}/?ref=${encodeURIComponent(userLogin)}`
      : `https://agent.openaimp.com/?ref=${encodeURIComponent(userLogin)}`;

  const copyLink = useCallback(() => {
    navigator.clipboard.writeText(referralLink).catch(() => {});
    setCopied(true);
    setTimeout(() => setCopied(false), 2500);
  }, [referralLink]);

  if (loading) {
    return (
      <Card>
        <p>Referrals</p>
        <p>Loading…</p>
      </Card>
    );
  }
  if (loadError || !view) {
    return (
      <Card>
        <p>Referrals</p>
        <Notice tone="warning">{loadError ?? "Your referral details could not be loaded."}</Notice>
      </Card>
    );
  }

  const { extension } = view;
  const shareMessage = renderShareMessage(view.shareMessageTemplate, view.referredTrialDays, referralLink);
  return (
    <Card>
      <p>Referrals</p>
      <p>
        Share your link — anyone who signs up with it gets a {view.referredTrialDays}-day free trial,
        and you earn trial days when they complete their first paid run.
      </p>
      <TextInput label="Your referral link" value={referralLink} readOnly />
      <Button onClick={copyLink}>{copied ? "Copied" : "Copy referral link"}</Button>
      <p>{shareMessage}</p>
      <p>People you referred: {extension.referredCount}</p>
      <p>
        Trial days earned: {extension.totalExtensionDays}
        {extension.appliedDays > 0 && ` (${extension.appliedDays} applied to your trial)`}
        {extension.bankedDays > 0 && `, ${extension.bankedDays} banked as free days`}
        {extension.expiredDays > 0 && `, ${extension.expiredDays} expired`}
      </p>
      <p>
        {extension.trialEndsAtMs !== null
          ? `Your trial ends ${new Date(extension.trialEndsAtMs).toISOString().slice(0, 10)}.`
          : "You have no active trial."}
      </p>
    </Card>
  );
}
