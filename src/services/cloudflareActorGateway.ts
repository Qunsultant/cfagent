/**
 * Issue #1779 (Adapter S5, program #1717) — the Cloudflare
 * implementation of the ActorGateway port (`actorGatewayPorts.ts`).
 *
 * This is the ONLY module in the repo that calls `idFromName` /
 * `idFromString` / `get` for actor dispatch. Every other module
 * reaches DO instances through the `ActorGateway` interface;
 * application code must not import this module's binding calls,
 * only the port and this factory / shared instance.
 *
 * The implementation is a verbatim centralisation of the pre-S5 call
 * sites: `namespace.get(namespace.idFromName(name))`, then
 * `stub.fetch(request)` for dispatch or a typed method call for RPC.
 * Nothing is reordered, retried, or defaulted: a missing namespace
 * or a missing addressing method throws a named ActorGateway error
 * (previously a bare TypeError at the same point), and a stub
 * without `fetch` surfaces the same failure a direct call would.
 * The gateway is stateless — the shared `actorGateway` instance is
 * safe to import anywhere; `createActorGateway()` exists for tests
 * and for callers that prefer a fresh instance.
 */

import type {
  ActorGateway,
  ActorNamespaceLike,
  ActorStubLike,
  PaymentsAgentStub,
} from "./actorGatewayPorts";

function requireNamespace(
  namespace: ActorNamespaceLike | undefined | null,
): ActorNamespaceLike {
  if (
    !namespace ||
    typeof (namespace as ActorNamespaceLike).idFromName !== "function" ||
    typeof (namespace as ActorNamespaceLike).get !== "function"
  ) {
    throw new Error(
      "ActorGateway: DO namespace binding is not configured (missing namespace or idFromName/get).",
    );
  }
  return namespace;
}

class CloudflareActorGateway implements ActorGateway {
  address(namespace: ActorNamespaceLike, instanceName: string): unknown {
    return requireNamespace(namespace).idFromName(instanceName);
  }

  addressFromId(namespace: ActorNamespaceLike, id: string): unknown {
    const ns = requireNamespace(namespace);
    if (typeof ns.idFromString !== "function") {
      throw new Error(
        "ActorGateway: DO namespace has no idFromString — cannot address an instance by id.",
      );
    }
    return ns.idFromString(id);
  }

  stub<T>(namespace: ActorNamespaceLike, instanceName: string): T {
    // Resolve first: reading `namespace.get` before validation would
    // throw a bare TypeError on a missing namespace instead of the
    // named ActorGateway error.
    const id = this.address(namespace, instanceName);
    return requireNamespace(namespace).get(id) as unknown as T;
  }

  stubFromId<T>(namespace: ActorNamespaceLike, id: string): T {
    const resolvedId = this.addressFromId(namespace, id);
    return requireNamespace(namespace).get(resolvedId) as unknown as T;
  }

  dispatch(
    namespace: ActorNamespaceLike,
    instanceName: string,
    request: Request,
  ): Promise<Response> {
    const stub = this.stub<ActorStubLike>(namespace, instanceName);
    return stub.fetch(request);
  }

  dispatchFromId(
    namespace: ActorNamespaceLike,
    id: string,
    request: Request,
  ): Promise<Response> {
    const stub = this.stubFromId<ActorStubLike>(namespace, id);
    return stub.fetch(request);
  }

  paymentsStub(namespace: ActorNamespaceLike): PaymentsAgentStub {
    return this.stub<PaymentsAgentStub>(namespace, "default");
  }
}

/** The shared, stateless Cloudflare ActorGateway. */
export const actorGateway: ActorGateway = new CloudflareActorGateway();

/** Build a fresh Cloudflare ActorGateway (tests, or callers that prefer one). */
export function createActorGateway(): ActorGateway {
  return new CloudflareActorGateway();
}
