/**
 * Issue #1778 (Adapter S4, program #1717) — the Cloudflare EMAIL
 * implementation of the EmailSender port (`emailSenderPorts.ts`).
 *
 * This is the ONLY module in the repo that calls `EMAIL.send`.
 * Every other module reaches outbound email through the `EmailSender`
 * interface; application code must not import this module's binding
 * call, only the port and this factory.
 *
 * MIME assembly is moved verbatim from the pre-S4 call site in
 * `src/trading/email/agent.ts` (`sendOutboundEmail`): multipart
 * alternative body, multipart/mixed wrapper when attachments are
 * present, base64 parts wrapped at 76 columns, sanitised attachment
 * filenames, `X-Agent-DID` attestation. The fail-soft contract is
 * preserved exactly: a send failure warns (same log tag as before)
 * and returns false; a missing binding never reaches this class —
 * the factory returns null and the caller returns false.
 */

import type {
  EmailAttachment,
  EmailMessage,
  EmailSender,
} from "./emailSenderPorts";
import { AGENT_DIDS } from "../agents/did";
import { createStructuredLogger } from "../observability/structuredLogger";
import { createObservabilitySink } from "../observability/createObservabilityPorts";

/** Issue #3515 S3 — module logger on the S2 structured-logging seam. */
const structuredLog = createStructuredLogger(createObservabilitySink({}), {
  component: "services/cloudflareEmailSender",
});

/** The env half the adapter needs — the EMAIL binding, nothing else. */
export interface EmailSenderEnv {
  EMAIL?: { send: (body: unknown) => Promise<unknown> };
  EMAIL_AGENT_ADDRESS?: string;
}

/** Default From when neither the message nor the env supplies one. */
export const DEFAULT_EMAIL_FROM = "trade@agent.openaimp.com";

class CloudflareEmailSender implements EmailSender {
  constructor(
    private readonly binding: { send: (body: unknown) => Promise<unknown> },
    private readonly fromAddress: string,
  ) {}

  async send(message: EmailMessage): Promise<boolean> {
    try {
      const fromAddress = message.from || this.fromAddress;
      const attachments: EmailAttachment[] = message.attachments ?? [];
      const alternativeBoundary = `----=_Alternative_${crypto.randomUUID()}`;
      const mixedBoundary = `----=_Mixed_${crypto.randomUUID()}`;
      const rawParts = [
        `From: "E*TRADE Agentic Trading Hub" <${fromAddress}>`,
        `To: <${message.to}>`,
        `Subject: ${message.subject}`,
        `MIME-Version: 1.0`,
        `Content-Type: ${attachments.length > 0 ? `multipart/mixed; boundary="${mixedBoundary}"` : `multipart/alternative; boundary="${alternativeBoundary}"`}`,
        `X-Agent-DID: ${AGENT_DIDS.TRADING}`,
        ``,
      ];
      if (attachments.length > 0) {
        rawParts.push(
          `--${mixedBoundary}`,
          `Content-Type: multipart/alternative; boundary="${alternativeBoundary}"`,
          ``,
        );
      }
      rawParts.push(
        `--${alternativeBoundary}`,
        `Content-Type: text/plain; charset=UTF-8`,
        `Content-Transfer-Encoding: 7bit`,
        ``,
        message.text,
        ``,
        `--${alternativeBoundary}`,
        `Content-Type: text/html; charset=UTF-8`,
        `Content-Transfer-Encoding: 7bit`,
        ``,
        message.html,
        ``,
        `--${alternativeBoundary}--`,
      );
      if (attachments.length > 0) {
        for (const att of attachments) {
          const safeFileName = att.fileName.replace(/[^a-zA-Z0-9._-]/g, "_") || "research.xlsx";
          rawParts.push(
            ``,
            `--${mixedBoundary}`,
            `Content-Type: ${att.contentType}; name="${safeFileName}"`,
            `Content-Disposition: attachment; filename="${safeFileName}"`,
            `Content-Transfer-Encoding: base64`,
            ``,
            att.contentBase64.match(/.{1,76}/g)?.join("\r\n") || "",
          );
        }
        rawParts.push(``, `--${mixedBoundary}--`);
      }
      const rawMime = rawParts.join("\r\n");

      await this.binding.send(new Response(rawMime).body);
      return true;
    } catch (err) {
      structuredLog.warn("email.send_failed", {
        message: "[ETradeEmailService] Failed to send email via env.EMAIL binding",
        error: err instanceof Error ? err.message : String(err),
      });
      return false;
    }
  }
}

/**
 * Build the EmailSender for an env, or null when `EMAIL` is unbound
 * or lacks a `send` function. Callers keep their existing unbound
 * contract on null (fail-soft `false`) — the port never invents a
 * sender when the binding is absent.
 *
 * DEPLOYMENT NOTE: `EMAIL` is declared in `wrangler.jsonc`
 * (`send_email`, issue #2889, after account-side Email Sending
 * provisioning). The null path above remains for unbound envs
 * (local/dev without the binding) — it is the fail-soft contract,
 * not a second send path.
 */
export function createEmailSender(env: EmailSenderEnv | undefined | null): EmailSender | null {
  const binding = env?.EMAIL;
  if (!binding || typeof binding.send !== "function") return null;
  return new CloudflareEmailSender(binding, env?.EMAIL_AGENT_ADDRESS || DEFAULT_EMAIL_FROM);
}
