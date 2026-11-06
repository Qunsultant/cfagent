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
import { D1JobPipelineStores, type JobPipelineD1Db } from "./d1JobPipelineAdapter";
import { DoSqliteJobPipelineStores } from "./doSqliteJobPipelineAdapter";
import type { JobPipelineStores } from "./jobPipelinePorts";

/** Build the pipeline stores over a host Durable Object's SQLite. */
export function createJobPipelineStoresFromSql(sql: SqlStorage): JobPipelineStores {
  return new DoSqliteJobPipelineStores(sql);
}

/** Build the pipeline stores over the shared D1 AgentDB binding. */
export function createJobPipelineStoresFromD1(db: JobPipelineD1Db): JobPipelineStores {
  return new D1JobPipelineStores(db);
}

export type { JobPipelineStores } from "./jobPipelinePorts";
export type { JobPipelineD1Db } from "./d1JobPipelineAdapter";
