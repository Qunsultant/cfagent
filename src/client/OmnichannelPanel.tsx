import { Badge, Button, Card, CardHeader, Flex, Grid, Notice, PageSection, PageShell, Stack, TextInput } from "./components/ui";
import type { BrokerPresentation } from "../trading";
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
        <Stack gap="2">
          {/* Issue #3429: the desks execute against E*TRADE, so another broker is told\n              before it types a command — the backend refuses the same request. */}
          {selectedBroker !== "etrade" && (
            <Notice tone="warning" title={`${presentation.label} does not run these desks`}>
              The email, Slack and voice desks execute against E*TRADE. Nothing here is previewed or\n              routed for {presentation.label}; use the Trading Hub order ticket or the neutral order API.
            </Notice>
          )}
          {/* Header Card */}
          <Card padding="md">
            <CardHeader
              title="💬 Omnichannel Trading Desks (Email & Slack)"
              subtitle={<>Autonomous market research, quoting, and Human-in-the-Loop order drafting via Inbound Email and Slack Bot communication channels. All orders require explicit human authorization before live {presentation.label} execution.</>}
              belowSubtitle={
                <Badge tone="accent" size="xs" uppercase>
                  Autonomous Multi-Agent Architecture
                </Badge>
              }
              meta={
                <Badge tone={isLive ? "success" : "neutral"} dot>
                  ✓ {presentation.label} REST API · {isLive ? "LIVE" : "PAPER"}
                </Badge>
              }
            />
          </Card>

          <Grid autoFit minColumnWidth="xl" gap="2">
            {/* Channel 1: Autonomous Email Trading Desk */}
            <Card padding="md">
              <Stack gap="2">
              <CardHeader
                title={<><span>✉️</span> Autonomous Email Trading Desk</>}
                meta={
                  <Badge tone="info" size="sm">
                    send_email &amp; PostalMime
                  </Badge>
                }
              />

              <Card padding="sm">
                <Stack gap="1">
                  <div>
                    <strong>Inbound Address:</strong> <code>trade@agent.openaimp.com</code>
                  </div>
                  <div>
                    <strong>Security Guarantee:</strong> Stamped with Trading DID (<code>did:agent:openaimp:trading</code>).
                  </div>
                  <div>
                    <strong>Commands:</strong> <code>Quote &lt;SYMBOL&gt;</code>, <code>Screen stocks priced between $20 and $200</code>, <code>Preview Buy 10 NVDA limit 125</code>, <code>APPROVE &lt;orderId&gt;</code>.
                  </div>
                </Stack>
              </Card>

              {/* Email Simulator Form */}
              <Card padding="sm">
                <Stack gap="2">
                <CardHeader title="🧪 Interactive Email Simulator" />
                <Stack gap="2">
                  <TextInput label="From (Sender Email):" id="omni-email-from"
                    type="email"
                    value={emailFrom}
                    onChange={(e) => setEmailFrom(e.target.value)}
                  />
                  <TextInput label="Subject:" id="omni-email-subject"
                    type="text"
                    value={emailSubject}
                    onChange={(e) => setEmailSubject(e.target.value)}
                  />
                  <TextInput label="Email Body:" id="omni-email-body"
                    multiline
                    rows={2}
                    value={emailBody}
                    onChange={(e) => setEmailBody(e.target.value)}
                  />

                  {/* Preset Quick Chips */}
                  <Flex gap="1" wrap>
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
                  </Flex>

                  <Button
                    disabled={emailLoading}
                    onClick={handleSimulateEmail}
                    variant="primary"
                   loading={emailLoading}>
                    {"⚡ Send Test Email to Agent"}
                  </Button>
                </Stack>
                </Stack>
              </Card>

              {/* Email Result Output */}
              {emailResult && (
                <Card padding="sm">
                  <Stack gap="1">
                    <Flex gap="2" align="center" justify="between" wrap>
                      <strong>Agent Email Reply:</strong>
                      <Badge tone="accent" size="xs" uppercase>
                        {emailResult.actionType || "reply"}
                      </Badge>
                    </Flex>
                    <h6>
                      Subject: {emailResult.responseSubject}
                    </h6>
                    {emailResult.responseHtml ? (
                      <div
                        dangerouslySetInnerHTML={{ __html: emailResult.responseHtml }}
                      />
                    ) : (
                      <pre>
                        {emailResult.responseText}
                      </pre>
                    )}
                  </Stack>
                </Card>
              )}
              </Stack>
            </Card>

            {/* Channel 2: Autonomous Slack Trading Desk */}
            <Card padding="md">
              <Stack gap="2">
              <CardHeader
                title={<><span>🤖</span> Autonomous Slack Trading Desk</>}
                meta={
                  <Badge tone="purple" size="sm">
                    Events &amp; Block Kit
                  </Badge>
                }
              />

              <Card padding="sm">
                <Stack gap="1">
                  <div>
                    <strong>Event Request URL:</strong> <code>https://agent.openaimp.com/slack/events</code>
                  </div>
                  <div>
                    <strong>Interactivity URL:</strong> <code>https://agent.openaimp.com/slack/interactions</code>
                  </div>
                  <div>
                    <strong>OAuth App Install:</strong> <Button href="/slack/install" target="_blank" variant="secondary" tone="subtle" size="sm">Install to Workspace</Button>
                  </div>
                </Stack>
              </Card>

              {/* Slack Simulator Form */}
              <Card padding="sm">
                <Stack gap="2">
                <CardHeader title="🧪 Interactive Slack Bot Simulator" />
                <Stack gap="2">
                  <TextInput label="Slack Message / Mention:" id="omni-slack-message"
                    type="text"
                    value={slackPrompt}
                    onChange={(e) => setSlackPrompt(e.target.value)}
                  />

                  {/* Preset Quick Chips */}
                  <Flex gap="1" wrap>
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
                  </Flex>

                  <Button
                    disabled={slackLoading}
                    onClick={() => handleSimulateSlack()}
                    variant="primary"
                   loading={slackLoading}>
                    {"⚡ Simulate Slack Message"}
                  </Button>
                </Stack>
                </Stack>
              </Card>

              {/* Slack Block Kit Card Viewer */}
              {slackResult?.response && (
                <Card padding="sm">
                  <Stack gap="2">
                    <Flex gap="2" align="center">
                      <span style={{ fontSize: "var(--font-size-title)" }}>🤖</span>
                      <div>
                        <strong>{presentation.botName}</strong>{" "}
                        <Badge tone="neutral" size="xs">APP</Badge>{" "}
                        <span className="ui-meta-sm">Just now</span>
                      </div>
                    </Flex>

                    <Stack gap="2">
                      {slackResult.response.blocks?.map((block: any, bIdx: number) => {
                        if (block.type === "header") {
                          return <h5 key={bIdx}>{block.text?.text}</h5>;
                        }
                        if (block.type === "section" && block.fields) {
                          return (
                            <Grid key={bIdx} columns={2} gap="1">
                              {block.fields.map((f: any, fIdx: number) => (
                                <Card key={fIdx} padding="sm">
                                  <Stack gap="0-5">
                                    {f.text?.split("\n").map((line: string, lIdx: number) => (
                                      <div key={lIdx}>{line.replace(/\*/g, "")}</div>
                                    ))}
                                  </Stack>
                                </Card>
                              ))}
                            </Grid>
                          );
                        }
                        if (block.type === "section" && block.text) {
                          return <p key={bIdx} className="ui-footnote">{block.text.text?.replace(/\*/g, "")}</p>;
                        }
                        if (block.type === "actions") {
                          return (
                            <Flex key={bIdx} gap="1" wrap>
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
                            </Flex>
                          );
                        }
                        if (block.type === "context") {
                          return (
                            <p key={bIdx} className="ui-footnote">
                              {block.elements?.[0]?.text?.replace(/`/g, "")}
                            </p>
                          );
                        }
                        return null;
                      })}
                    </Stack>
                  </Stack>
                </Card>
              )}
              </Stack>
            </Card>
          </Grid>
        </Stack>
      </PageSection>
    </PageShell>
  );
}
