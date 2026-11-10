import { Button, Notice, PageSection, PageShell, TextInput } from "./components/ui";
import type { BrokerPresentation } from "../trading/brokerPresentation";
import type { BrokerOrderDraft } from "../types";

/**
 * Omnichannel trading desks panel (issue #3050, PR5).
 *
 * Moved out of the Hub's inline markup: the autonomous email and Slack
 * trading desks with their simulators, rendered in its own PageShell inside
 * the hub's shared shell. The markup is the Hub's, unchanged — only the
 * shell wrapper and section are new. Hub state and handlers arrive as props;
 * no data flow changed.
 */
interface OmnichannelPanelProps {
  presentation: BrokerPresentation;
  selectedBroker: string;
  isLive: boolean;
  emailFrom: string;
  setEmailFrom: (value: string) => void;
  emailSubject: string;
  setEmailSubject: (value: string) => void;
  emailBody: string;
  setEmailBody: (value: string) => void;
  emailLoading: boolean;
  emailResult: any;
  handleSimulateEmail: () => Promise<void>;
  activeDraft: BrokerOrderDraft | null;
  slackPrompt: string;
  setSlackPrompt: (value: string) => void;
  slackLoading: boolean;
  slackResult: any;
  handleSimulateSlack: (customPrompt?: string) => Promise<void>;
  handleSlackActionButton: (actionId: string, orderId: string) => Promise<void>;
  slackActionLoading: boolean;
}

export function OmnichannelPanel({
  presentation,
  selectedBroker,
  isLive,
  emailFrom,
  setEmailFrom,
  emailSubject,
  setEmailSubject,
  emailBody,
  setEmailBody,
  emailLoading,
  emailResult,
  handleSimulateEmail,
  activeDraft,
  slackPrompt,
  setSlackPrompt,
  slackLoading,
  slackResult,
  handleSimulateSlack,
  handleSlackActionButton,
  slackActionLoading,
}: OmnichannelPanelProps) {
  return (
    <PageShell
      title="Omnichannel Trading Desks"
      scopeNote="Autonomous market research, quoting, and Human-in-the-Loop order drafting via inbound email and the Slack bot — all orders require explicit human authorization."
    >
      <PageSection title="Omnichannel trading desks">
        <div className="tab-pane active omnichannel-pane">
          {/* Issue #3429: the desks execute against E*TRADE, so another broker is told\n              before it types a command — the backend refuses the same request. */}
          {selectedBroker !== "etrade" && (
            <Notice tone="warning" title={`${presentation.label} does not run these desks`}>
              The email, Slack and voice desks execute against E*TRADE. Nothing here is previewed or\n              routed for {presentation.label}; use the Trading Hub order ticket or the neutral order API.
            </Notice>
          )}
          {/* Header Card */}
          <div className="omnichannel-header-card">
            <div className="omnichannel-header-top">
              <div>
                <span className="omnichannel-header-badge">
                  Autonomous Multi-Agent Architecture
                </span>
                <h3 className="omnichannel-header-title">
                  💬 Omnichannel Trading Desks (Email &amp; Slack)
                </h3>
                <p className="omnichannel-header-desc">
                  Autonomous market research, quoting, and Human-in-the-Loop order drafting via Inbound Email and Slack Bot communication channels. All orders require explicit human authorization before live {presentation.label} execution.
                </p>
              </div>
              <div className="omnichannel-header-status">
                <span className="omnichannel-live-badge">
                  ✓ {presentation.label} REST API · {isLive ? "LIVE" : "PAPER"}
                </span>
              </div>
            </div>
          </div>

          <div className="omnichannel-grid">
            {/* Channel 1: Autonomous Email Trading Desk */}
            <div className="omnichannel-card">
              <div className="omnichannel-card-header">
                <h4 className="omnichannel-card-title email">
                  <span>✉️</span> Autonomous Email Trading Desk
                </h4>
                <span className="omnichannel-badge-subtle cyan">
                  send_email &amp; PostalMime
                </span>
              </div>

              <div className="omnichannel-meta-box">
                <div style={{ marginBottom: "0.4rem" }}>
                  <strong>Inbound Address:</strong> <code>trade@agent.openaimp.com</code>
                </div>
                <div style={{ marginBottom: "0.4rem" }}>
                  <strong>Security Guarantee:</strong> Stamped with Trading DID (<code>did:agent:openaimp:trading</code>).
                </div>
                <div>
                  <strong>Commands:</strong> <code>Quote &lt;SYMBOL&gt;</code>, <code>Screen stocks priced between $20 and $200</code>, <code>Preview Buy 10 NVDA limit 125</code>, <code>APPROVE &lt;orderId&gt;</code>.
                </div>
              </div>

              {/* Email Simulator Form */}
              <div className="omnichannel-simulator-card">
                <h5 className="omnichannel-simulator-title">
                  🧪 Interactive Email Simulator
                </h5>
                <div className="omnichannel-form-group">
                  <div>
                    <TextInput label="From (Sender Email):" id="omni-email-from"
                      type="email"
                      value={emailFrom}
                      onChange={(e) => setEmailFrom(e.target.value)}
                    />
                  </div>
                  <div>
                    <TextInput label="Subject:" id="omni-email-subject"
                      type="text"
                      value={emailSubject}
                      onChange={(e) => setEmailSubject(e.target.value)}
                    />
                  </div>
                  <div>
                    <TextInput label="Email Body:" id="omni-email-body"
                      multiline
                      rows={2}
                      value={emailBody}
                      onChange={(e) => setEmailBody(e.target.value)}
                    />
                  </div>

                  {/* Preset Quick Chips */}
                  <div className="omnichannel-chip-row">
                    <Button
                      onClick={() => { setEmailSubject("Quote NVDA"); setEmailBody("What is the current price and technicals?"); }}
                      variant="secondary"
                      tone="subtle"
                      size="sm"
                    >
                      📈 Quote NVDA
                    </Button>
                    <Button
                      onClick={() => { setEmailSubject("Screen stock price range"); setEmailBody("Show stocks priced between $20 and $200"); }}
                      variant="secondary"
                      tone="subtle"
                      size="sm"
                    >
                      🔍 Screen Price Range
                    </Button>
                    <Button
                      onClick={() => { setEmailSubject("Order Preview"); setEmailBody("Buy 10 shares of NVDA limit 125.00"); }}
                      variant="secondary"
                      tone="subtle"
                      size="sm"
                    >
                      🛡️ Buy 10 NVDA
                    </Button>
                    {activeDraft && (
                      <Button
                        onClick={() => { setEmailSubject("Order Approval"); setEmailBody(`APPROVE ${activeDraft.orderId}`); }}
                        variant="primary"
                        tone="subtle"
                        size="sm"
                      >
                        ✓ APPROVE {activeDraft.orderId}
                      </Button>
                    )}
                  </div>

                  <Button
                    disabled={emailLoading}
                    onClick={handleSimulateEmail}
                    variant="primary"
                   loading={emailLoading}>
                    {"⚡ Send Test Email to Agent"}
                  </Button>
                </div>
              </div>

              {/* Email Result Output */}
              {emailResult && (
                <div className="omnichannel-result-box">
                  <div className="omnichannel-result-header">
                    <span className="omnichannel-result-title">Agent Email Reply:</span>
                    <span className="omnichannel-result-action">
                      {emailResult.actionType || "reply"}
                    </span>
                  </div>
                  <h6 className="omnichannel-result-subject">
                    Subject: {emailResult.responseSubject}
                  </h6>
                  {emailResult.responseHtml ? (
                    <div
                      className="omnichannel-result-html"
                      dangerouslySetInnerHTML={{ __html: emailResult.responseHtml }}
                    />
                  ) : (
                    <pre className="omnichannel-result-pre">
                      {emailResult.responseText}
                    </pre>
                  )}
                </div>
              )}
            </div>

            {/* Channel 2: Autonomous Slack Trading Desk */}
            <div className="omnichannel-card">
              <div className="omnichannel-card-header">
                <h4 className="omnichannel-card-title slack">
                  <span>🤖</span> Autonomous Slack Trading Desk
                </h4>
                <span className="omnichannel-badge-subtle purple">
                  Events &amp; Block Kit
                </span>
              </div>

              <div className="omnichannel-meta-box">
                <div style={{ marginBottom: "0.4rem" }}>
                  <strong>Event Request URL:</strong> <code className="slack-url">https://agent.openaimp.com/slack/events</code>
                </div>
                <div style={{ marginBottom: "0.4rem" }}>
                  <strong>Interactivity URL:</strong> <code className="slack-url">https://agent.openaimp.com/slack/interactions</code>
                </div>
                <div>
                  <strong>OAuth App Install:</strong> <a href="/slack/install" target="_blank" rel="noreferrer" className="slack-install-link">Install to Workspace</a>
                </div>
              </div>

              {/* Slack Simulator Form */}
              <div className="omnichannel-simulator-card">
                <h5 className="omnichannel-simulator-title">
                  🧪 Interactive Slack Bot Simulator
                </h5>
                <div className="omnichannel-form-group">
                  <div>
                    <TextInput label="Slack Message / Mention:" id="omni-slack-message"
                      type="text"
                      value={slackPrompt}
                      onChange={(e) => setSlackPrompt(e.target.value)}
                    />
                  </div>

                  {/* Preset Quick Chips */}
                  <div className="omnichannel-chip-row">
                    <Button
                      onClick={() => handleSimulateSlack(`@${presentation.botName} quote NVDA`)}
                      variant="secondary"
                      tone="subtle"
                      size="sm"
                    >
                      📈 Quote NVDA
                    </Button>
                    <Button
                      onClick={() => handleSimulateSlack(`@${presentation.botName} screen stocks priced between $20 and $200`)}
                      variant="secondary"
                      tone="subtle"
                      size="sm"
                    >
                      🔍 Screen Price Range
                    </Button>
                    <Button
                      onClick={() => handleSimulateSlack(`@${presentation.botName} preview buy 10 NVDA limit 125.00`)}
                      variant="secondary"
                      tone="subtle"
                      size="sm"
                    >
                      ⚡ Buy 10 NVDA Ticket
                    </Button>
                    <Button
                      onClick={() => handleSimulateSlack(`@${presentation.botName} show my portfolio positions`)}
                      variant="secondary"
                      tone="subtle"
                      size="sm"
                    >
                      💼 Portfolio
                    </Button>
                  </div>

                  <Button
                    disabled={slackLoading}
                    onClick={() => handleSimulateSlack()}
                    variant="primary"
                   loading={slackLoading}>
                    {"⚡ Simulate Slack Message"}
                  </Button>
                </div>
              </div>

              {/* Slack Block Kit Card Viewer */}
              {slackResult?.response && (
                <div className="omnichannel-slack-viewer">
                  <div className="omnichannel-slack-user-header">
                    <span style={{ fontSize: "var(--font-size-title)" }}>🤖</span>
                    <div>
                      <strong className="slack-bot-name">{presentation.botName}</strong>{" "}
                      <span className="slack-app-tag">APP</span>
                      <span className="slack-time">Just now</span>
                    </div>
                  </div>

                  <div className="omnichannel-slack-body">
                    {slackResult.response.blocks?.map((block: any, bIdx: number) => {
                      if (block.type === "header") {
                        return <h5 key={bIdx} className="slack-block-heading">{block.text?.text}</h5>;
                      }
                      if (block.type === "section" && block.fields) {
                        return (
                          <div key={bIdx} className="slack-block-fields">
                            {block.fields.map((f: any, fIdx: number) => (
                              <div key={fIdx} className="omnichannel-slack-field">
                                {f.text?.split("\n").map((line: string, lIdx: number) => (
                                  <div key={lIdx}>{line.replace(/\*/g, "")}</div>
                                ))}
                              </div>
                            ))}
                          </div>
                        );
                      }
                      if (block.type === "section" && block.text) {
                        return <p key={bIdx} className="slack-block-text">{block.text.text?.replace(/\*/g, "")}</p>;
                      }
                      if (block.type === "actions") {
                        return (
                          <div key={bIdx} className="slack-actions-row">
                            {block.elements?.map((btn: any, btnIdx: number) => (
                              <Button
                                variant={btn.style === "primary" ? "primary" : "danger"}
                                key={btnIdx}
                                disabled={slackActionLoading}
                                onClick={() => handleSlackActionButton(btn.action_id, btn.value)}
                                style={{
                                  background: btn.style === "primary" ? "var(--color-success)" : "var(--color-danger)",
                                  color: "var(--color-text-inverse)",
                                  border: "none",
                                  borderRadius: "var(--radius-xs, 4px)",
                                  padding: "var(--space-1-5) var(--space-3)",
                                  fontWeight: "bold",
                                  fontSize: "var(--font-size-body-sm)",
                                  cursor: "pointer",
                                }}
                              >
                                {btn.text?.text}
                              </Button>
                            ))}
                          </div>
                        );
                      }
                      if (block.type === "context") {
                        return (
                          <div key={bIdx} className="slack-context-row">
                            {block.elements?.[0]?.text?.replace(/`/g, "")}
                          </div>
                        );
                      }
                      return null;
                    })}
                  </div>
                </div>
              )}
            </div>
          </div>
        </div>
      </PageSection>
    </PageShell>
  );
}
