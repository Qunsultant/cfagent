/**
 * Issue #3534 (Pipeline J1) — composition roots for the
 * job-pipeline stores. Hosts construct the stores explicitly for
 * their residency: an agent host passes its own DO SQLite
 * (agent-hosted, mirroring how hosts build SqlJobRunRecordStore);
 * a workflow host passes the AGENT_DB D1 binding
 * (workflow-hosted). There is deliberately no env-only factory
 * that could silently fall back to in-memory storage in
 * production — the in-memory stores are constructed explicitly
 * by tests and local development through
 * inMemoryJobPipelineAdapter.
 */
import type { SqlStorage } from "../orm";
import {
  createD1JobPipelineDb,
  D1JobPipelineStores,
} from "./d1JobPipelineAdapter";
import {
  DoSqliteJobPipelineStores,
  type DoSqliteJobPipelineOptions,
} from "./doSqliteJobPipelineAdapter";
import type { JobPipelineStores } from "./jobPipelinePorts";

/** Build the pipeline stores over a host Durable Object's SQLite. */
export function createJobPipelineStoresFromSql(
  sql: SqlStorage,
  options?: DoSqliteJobPipelineOptions,
): JobPipelineStores {
  return new DoSqliteJobPipelineStores(sql, options);
}

/** Build the pipeline stores over the shared D1 AgentDB binding. */
export function createJobPipelineStoresFromD1(d1: D1Database): JobPipelineStores {
  return new D1JobPipelineStores(createD1JobPipelineDb(d1));
}

export type { JobPipelineStores } from "./jobPipelinePorts";
export type { JobPipelineDb } from "./d1JobPipelineAdapter";
