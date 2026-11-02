/**
 * Issue #1778 (Adapter S4, program #1717) — the one EmailSender port.
 *
 * Before S4, `src/trading/email/agent.ts` called the Cloudflare Email
 * Sending binding directly (`this.env.EMAIL.send(…)`) with no interface.
 * After S4 every send from that site goes through this interface, and
 * the Cloudflare implementation in `cloudflareEmailSender.ts` is the
 * ONLY module that calls `EMAIL.send`.
 *
 * This file carries types + the interface ONLY — no provider access.
 * The `From` address is adapter-resolved: an explicit `from` on the
 * message wins, else the adapter's `EMAIL_AGENT_ADDRESS`, else
 * `trade@agent.openaimp.com` — the same resolution the direct call
 * site used before S4. The port never invents a sender when the
 * binding is absent: `createEmailSender` returns null and the caller
 * keeps its existing fail-soft contract (warn + `false`, never a
 * throw for a missing binding). No config switch is needed for this
 * slice: no behavior variant is introduced, only the access path
 * moves, and no caller can configure away an enforcement through
 * this port (delivery, not an IAAA gate).
 */

/** One outbound attachment, as carried by the pre-S4 call site. */
export interface EmailAttachment {
  fileName: string;
  contentType: string;
  contentBase64: string;
}

/** A structured outbound message — MIME assembly lives in the adapter. */
export interface EmailMessage {
  to: string;
  subject: string;
  html: string;
  text: string;
  /** Optional explicit From; adapter resolution applies when omitted. */
  from?: string;
  attachments?: EmailAttachment[];
}

/**
 * The email-sending port: `true` when the binding accepted the
 * message, `false` when sending failed (fail-soft — the adapter
 * warns and returns false rather than throwing on a send failure).
 * Recipient/subject validation stays with the caller and still
 * throws before the port is reached.
 */
export interface EmailSender {
  send(message: EmailMessage): Promise<boolean>;
}
