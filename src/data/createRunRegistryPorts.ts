/**
 * Issue #5175 slice 2 — composition root for the run registry
 * family. This is the ONLY module that maps a host's storage
 * handle to the family's production implementations: domain code
 * imports this helper and the port types, never a store client.
 *
 * The family's hosts hold one handle: the DO sql executor
 * (ctx.storage.sql-shaped). Both roles (record / resolve) are
 * served by the one DO adapter over that handle — they are roles
 * over two tables in a single instance, so the root hands the
 * same store out twice.
 *
 * This module is SERVER-ONLY in effect (it wires the DO
 * adapters); client-reachable modules must import the port
 * TYPES from runRegistryPorts.ts (type-only, erased at compile
 * time), never this root.
 */
import { DoSqliteRunRegistryStore } from "./doSqliteRunRegistryAdapter";
import { InMemoryRunRegistryStore } from "./inMemoryRunRegistryAdapter";
import type {
  RunRegistryRecordPort,
  RunRegistryResolvePort,
  RunRegistrySqlExecutor,
} from "./runRegistryPorts";

export interface RunRegistryPorts {
  record: RunRegistryRecordPort;
  resolve: RunRegistryResolvePort;
}

/** Compose the family's ports over a host's DO storage. */
export function createRunRegistryPorts(
  sql: RunRegistrySqlExecutor,
): RunRegistryPorts {
  const store = new DoSqliteRunRegistryStore(sql);
  return { record: store, resolve: store };
}

/** Compose the family's ports over the in-memory adapter (tests). */
export function createInMemoryRunRegistryPorts(): RunRegistryPorts {
  const store = new InMemoryRunRegistryStore();
  return { record: store, resolve: store };
}
