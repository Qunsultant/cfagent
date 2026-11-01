import React from "react";
import { TextInput, Checkbox } from "../components/ui";
import type { CreatableJob } from "./types";

export interface NotificationFieldsProps {
  jobType: CreatableJob;
  pushToSlack: boolean;
  setPushToSlack: React.Dispatch<React.SetStateAction<boolean>>;
  slackChannel: string;
  setSlackChannel: React.Dispatch<React.SetStateAction<string>>;
  emailTo: string;
  setEmailTo: React.Dispatch<React.SetStateAction<string>>;
  webhookUrl: string;
  setWebhookUrl: React.Dispatch<React.SetStateAction<string>>;
}

export function NotificationFields(props: NotificationFieldsProps) {
  const {
    pushToSlack,
    setPushToSlack,
    slackChannel,
    setSlackChannel,
    emailTo,
    setEmailTo,
    webhookUrl,
    setWebhookUrl,
  } = props;
  // Consolidation #1236 (discovery notifications): discovery
  // schedules name delivery recipients too (panel surface of the
  // full-surface decision) — the strategyDiscovery early return
  // that hid this section is gone.
  return (
                <div className="sched-form-group">
                  <div className="sched-form-label">
                    Omnichannel Notification Dispatch
                    <span className="hint">Push reports and alerts automatically over Slack, Email (via cfpay A2A), and Webhooks</span>
                  </div>

                  <div className="channels-checkbox-grid">
                    {/* Slack */}
                    <div className="channel-check-card">
                      <div className="channel-check-top">
                        <Checkbox
                          label={<strong>Slack Block Kit</strong>}
                          checked={pushToSlack}
                          onChange={(e) => setPushToSlack(e.target.checked)}
                        />
                      </div>
                      <span className="channel-check-desc">
                        Interactive cards with PDF report attached and action shortcuts
                      </span>
                      {pushToSlack && (
                        <>
                          <TextInput
                            type="text"
                            style={{ marginTop: "0.3rem", padding: "var(--space-1-5) var(--space-2-5)", fontSize: "var(--font-size-caption)" }}
                            value={slackChannel}
                            onChange={(e) => setSlackChannel(e.target.value)}
                            placeholder="Slack Channel (e.g. #trading-desk)"
                          />
                          {/* Issue #2438: an empty stored channel renders
                              as an explicit Not set, never as a default
                              presented as stored (Details shows
                              "Configured (no channel recorded)" for
                              the same record). */}
                          {slackChannel.trim() === "" && (
                            <span className="hint" style={{ fontSize: "var(--font-size-caption)", color: "var(--color-text-muted)" }}>
                              Not set — no channel recorded for this schedule.
                            </span>
                          )}
                        </>
                      )}
                    </div>

                    {/* Email */}
                    <div className="channel-check-card">
                      <div className="channel-check-top">
                        <Checkbox
                          label={<strong>Email Channel (via cfpay A2A)</strong>}
                          checked={Boolean(emailTo)}
                          onChange={(e) => setEmailTo(e.target.checked ? "trader@firm.com" : "")}
                        />
                      </div>
                      <span className="channel-check-desc">
                        Full report with attached PDF, complete screened symbols table, and technicals
                      </span>
                      {Boolean(emailTo) && (
                        <TextInput
                          type="email"
                          style={{ marginTop: "0.3rem", padding: "var(--space-1-5) var(--space-2-5)", fontSize: "var(--font-size-caption)" }}
                          value={emailTo}
                          onChange={(e) => setEmailTo(e.target.value)}
                          placeholder="Recipient Email (e.g. trader@firm.com)"
                        />
                      )}
                    </div>

                    {/* Webhook */}
                    <div className="channel-check-card">
                      <div className="channel-check-top">
                        <Checkbox
                          label={<strong>Outbound Signed Webhook</strong>}
                          checked={Boolean(webhookUrl)}
                          onChange={(e) => setWebhookUrl(e.target.checked ? "https://api.firm.com/webhooks/screener" : "")}
                        />
                      </div>
                      <span className="channel-check-desc">
                        HMAC SHA-256 signed JSON payload. Dispatched only when OUTBOUND_WEBHOOK_SECRET is configured on the server — without a signing secret, the webhook is not sent.
                      </span>
                      {Boolean(webhookUrl) && (
                        <TextInput
                          type="url"
                          style={{ marginTop: "0.3rem", padding: "var(--space-1-5) var(--space-2-5)", fontSize: "var(--font-size-caption)" }}
                          value={webhookUrl}
                          onChange={(e) => setWebhookUrl(e.target.value)}
                          placeholder="https://..."
                        />
                      )}
                    </div>

                    {/* Broadcast */}
                    <div className="channel-check-card" style={{ opacity: 0.9 }}>
                      <div className="channel-check-top">
                        <strong>WebSocket UI Broadcast</strong>
                      </div>
                      <span className="channel-check-desc">
                        Not a channel you configure: when a scheduled run completes, its results are always broadcast to connected app clients.
                      </span>
                    </div>
                  </div>
                </div>
  );
}
