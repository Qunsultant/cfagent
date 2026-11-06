/**
 * Issue #3534 (Pipeline J1) — the in-memory implementation of the
 * job-pipeline stores: the test double every engine/control test
 * runs against, with semantics identical to the SQL adapters
 * (definitions by jobId, one instance record per job, artifacts
 * scoped by run). Constructed explicitly by its users (tests,
 * local development) — never as a silent production fallback.
 */
import type {
  JobDefinition,
  JobInstanceRecord,
  JobPipelineStores,
} from "./jobPipelinePorts";

function clone<T>(value: T): T {
  return value === undefined ? value : (JSON.parse(JSON.stringify(value)) as T);
}

export class InMemoryJobPipelineStores implements JobPipelineStores {
  private readonly definitionMap = new Map<string, JobDefinition>();
  private readonly instanceMap = new Map<string, JobInstanceRecord>();
  private readonly artifactMap = new Map<string, Map<string, unknown>>();

  readonly definitions = {
    saveDefinition: async (definition: JobDefinition): Promise<void> => {
      this.definitionMap.set(definition.jobId, clone(definition));
    },
    getDefinition: async (jobId: string): Promise<JobDefinition | null> => {
      const found = this.definitionMap.get(jobId);
      return found ? clone(found) : null;
    },
    listDefinitions: async (): Promise<JobDefinition[]> => {
      return [...this.definitionMap.values()].map((d) => clone(d));
    },
  };

  readonly instances = {
    getInstance: async (jobId: string): Promise<JobInstanceRecord | null> => {
      const found = this.instanceMap.get(jobId);
      return found ? clone(found) : null;
    },
    saveInstance: async (record: JobInstanceRecord): Promise<void> => {
      this.instanceMap.set(record.jobId, clone(record));
    },
  };

  readonly artifacts = {
    putArtifact: async (runId: string, key: string, value: unknown): Promise<void> => {
      let scoped = this.artifactMap.get(runId);
      if (!scoped) {
        scoped = new Map<string, unknown>();
        this.artifactMap.set(runId, scoped);
      }
      scoped.set(key, clone(value));
    },
    getArtifact: async (runId: string, key: string): Promise<unknown> => {
      const scoped = this.artifactMap.get(runId);
      if (!scoped || !scoped.has(key)) return null;
      return clone(scoped.get(key));
    },
    listArtifactKeys: async (runId: string): Promise<string[]> => {
      const scoped = this.artifactMap.get(runId);
      return scoped ? [...scoped.keys()].sort() : [];
    },
  };
}

/** Build a fresh in-memory store triple (one per test / host). */
export function createInMemoryJobPipelineStores(): JobPipelineStores {
  const stores = new InMemoryJobPipelineStores();
  return {
    definitions: stores.definitions,
    instances: stores.instances,
    artifacts: stores.artifacts,
  };
}
