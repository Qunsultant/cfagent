/**
 * GoF Facade Pattern & GRASP Controller: McpSystemFacade
 *
 * Implements:
 * - GoF Facade Pattern: Unified, simplified API to the subsystem (ORM, NLQ, Payments, DIDs, Observability).
 * - GRASP Controller Pattern: First non-UI object coordinating system operations.
 * - GRASP Information Expert: Delegates domain tasks to experts (ORM for tables, Strategy for payments).
 * - High Cohesion & Low Coupling: Shields Agents and MCP handlers from low-level dependencies.
 */

import type { Env } from "../types";
import type { DatabaseORM } from "../orm";
import type { IMcpSystemFacade, IAuditPublisher } from "./interfaces";
import { AuditEventPublisher, D1AuditObserver } from "./observer";
import { PaymentGatewayService, type CreateCheckoutParams, type CheckoutResult, type RefundParams, type RefundResult, type GatewayStatus, type SupportedGateway } from "../services/payments";
import { createDidAttestation, getUserDid, type DidAttestationProof, AGENT_DIDS } from "../agents/did";
import { planNLQ, executeNLQQueryAsync } from "../agents/nlq";

export class McpSystemFacade implements IMcpSystemFacade {
  public readonly auditPublisher: IAuditPublisher;
  private paymentService: PaymentGatewayService;

  constructor(
    public readonly env: Env,
    public readonly orm: DatabaseORM,
    public readonly sessionId: string
  ) {
    const publisher = new AuditEventPublisher(sessionId);
    // #6102: audit rows land in D1 now (the observer resolves the
    // port from the facade's env).
    publisher.subscribe(new D1AuditObserver(env));
    this.auditPublisher = publisher;
    this.paymentService = new PaymentGatewayService(env);
  }

  publishAudit(type: string, agent: any, payload: Record<string, unknown>): void {
    this.auditPublisher.publish(type, agent, payload);
  }

  async executeNlq(query: string): Promise<any> {
    const plan = await planNLQ(this.env, query);
    const result = await executeNLQQueryAsync(this.orm, this.sessionId, plan, this.env, this.sessionId);
    this.publishAudit("nlq.executed", "nlq", {
      query,
      domain: result.domain,
      operation: plan.operation,
      count: result.count,
    });
    return result;
  }

  async createCheckout(params: CreateCheckoutParams): Promise<CheckoutResult> {
    return this.paymentService.createCheckout(params);
  }

  async executeRefund(params: RefundParams): Promise<RefundResult> {
    return this.paymentService.executeRefund(params);
  }

  getGatewayStatuses(): GatewayStatus[] {
    return this.paymentService.getGatewayStatuses();
  }

  async createAttestation(params: {
    draftId: string;
    action: string;
    amount: number;
    currency: string;
    customer: string;
    gateway: SupportedGateway;
    proposerDid?: string;
  }): Promise<DidAttestationProof> {
    const authorizerDid = getUserDid(this.sessionId);
    return createDidAttestation({
      draftId: params.draftId,
      action: params.action,
      amount: params.amount,
      currency: params.currency,
      customer: params.customer,
      gateway: params.gateway,
      proposerDid: params.proposerDid || AGENT_DIDS.PAYMENTS,
      authorizerDid,
    }, this.env.DID_ATTESTATION_KEY);
  }
}
