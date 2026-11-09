/**
 * A stubbed broker for the cancel suites (#3883/#3884/#3885/#3886).
 *
 * No test moves funds: every cancel goes through this in-memory broker, which
 * records the calls it received so a suite can assert what was *sent* (not
 * only what came back). Not a `.test.ts` file, so vitest never runs it.
 */
import type { CancelBrokerPort } from "../src/services/orderCancellation";

export interface StubOrder {
  id: string;
  symbol: string;
  side: string;
  order_class: string;
  type: string;
  status: string;
  qty?: string;
  client_order_id?: string;
  submitted_at?: string;
  legs?: Array<{ id: string }>;
  /** Test-only: make the broker refuse this order's cancel. */
  __refuse?: boolean;
  /** Test-only: make the broker refuse to READ this order (500). */
  __unreadable?: boolean;
}

export interface StubBroker extends CancelBrokerPort {
  cancelled: string[];
  reads: string[];
  lists: number;
  orders: Map<string, StubOrder>;
  /** Alpaca cancels held legs with their parent; set false to model a broker that does not. */
  cascade: boolean;
}

export function stubBroker(initial: StubOrder[], options: { cascade?: boolean } = {}): StubBroker {
  const orders = new Map(initial.map((order) => [order.id, { ...order }]));
  const broker: StubBroker = {
    orders,
    cancelled: [],
    reads: [],
    lists: 0,
    cascade: options.cascade !== false,
    async getOrder(orderId: string) {
      broker.reads.push(orderId);
      const found = orders.get(orderId);
      if (!found) return { success: false, message: "order not found", httpStatus: 404 };
      if (found.__unreadable) return { success: false, message: "broker read failed", httpStatus: 500 };
      return { success: true, order: found };
    },
    async listOpenOrders() {
      broker.lists += 1;
      return {
        success: true,
        orders: Array.from(orders.values()).filter((order) => ["new", "held", "partially_filled"].includes(order.status)),
      };
    },
    async cancelOrder(orderId: string) {
      broker.cancelled.push(orderId);
      const found = orders.get(orderId);
      if (!found) return { success: false, orderId, message: "order not found", httpStatus: 404 };
      if (found.__refuse) return { success: false, orderId, message: "insufficient qty available", httpStatus: 422 };
      found.status = "canceled";
      if (broker.cascade) {
        for (const leg of found.legs ?? []) {
          const legOrder = orders.get(leg.id);
          if (legOrder && legOrder.status !== "filled") legOrder.status = "canceled";
        }
      }
      return { success: true, orderId, message: `Alpaca order ${orderId} cancelled.`, httpStatus: 204 };
    },
  };
  return broker;
}

/** Convenience: one simple open order. */
export function simpleOrder(overrides: Partial<StubOrder> = {}): StubOrder {
  return {
    id: "ord-1",
    symbol: "AAPL",
    side: "buy",
    order_class: "simple",
    type: "limit",
    status: "new",
    qty: "10",
    submitted_at: "2026-11-09T14:00:00.000Z",
    ...overrides,
  } as StubOrder;
}
