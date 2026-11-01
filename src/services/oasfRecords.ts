/**
 * Issue #2699 (programme #2494, AGNTCY slice 1) — OASF record
 * generation, local only.
 *
 * A pure generator that derives OASF (Open Agentic Schema
 * Framework) records, schema v1.1.0, from the two existing sources
 * of truth and nothing else:
 *
 *   - one record per fleet agent, from the A2A agent cards
 *     (src/a2a/agent-cards.ts) joined with the mesh registry
 *     (src/agents/registry.ts: MESH_SURFACES for the owning class,
 *     MESH_IDENTITIES for the class DID when one is recorded);
 *   - one record for the openaimp MCP server, from MCP_SERVER_INFO
 *     + MCP_TOOLS (src/mcps/openaimp/), with each catalog tool's
 *     skills resolved through its owning registry tool family
 *     (mcpCommandOwners()).
 *
 * Capabilities reach the records only as OASF taxonomy skill
 * classes through the pinned mapping tables below — never as
 * free text. An unmapped capability, family, or card throws, so a
 * source change without a mapping update fails loudly (and the
 * drift pins in tests/oasf_records_2699.test.ts fail CI).
 *
 * HARD BOUNDARY: generation is a build/test-time artifact only.
 * No route serves these records, nothing is published anywhere,
 * and no runtime path imports this module (pinned in tests).
 * Which records may ever be published — in particular the MCP
 * server record, which exposes the full catalog — is an owner
 * decision for a later slice.
 *
 * Taxonomy source: skill and domain class names/IDs are the OASF
 * v1.1.0 catalog values as served by the AGNTCY schema server
 * (https://schema.oasf.outshift.com/api/1.1.0/skills and /domains,
 * accessed 2026-11-01); released schema versions are immutable.
 * The record contract follows schema/objects/record.json at the
 * v1.1.0 tag: required name, version, schema_version, description,
 * authors, created_at (RFC 3339), skills; domains recommended;
 * locators optional.
 */

import { AGENT_CARDS, type AgentCard } from "../a2a/agent-cards";
import {
  MESH_SURFACES,
  getIdentityRecord,
  mcpCommandOwners,
} from "../agents/registry";
import { MCP_SERVER_INFO, MCP_TOOLS } from "../mcps/openaimp/index";

// ---------------------------------------------------------------------------
// Record contract types (OASF v1.1.0, proto agntcy.oasf.types.v1)
// ---------------------------------------------------------------------------

export interface OasfSkillRef {
  /** Taxonomy class ID from the OASF v1.1.0 skills catalog. */
  id: number;
  /** Full hierarchical class name, e.g. "tool_use_automation/workflow_automation". */
  name: string;
}

export interface OasfDomainRef {
  id: number;
  name: string;
}

export interface OasfLocator {
  type: string;
  urls: string[];
}

export interface OasfModule {
  name: string;
  id: number;
  data: Record<string, unknown>;
}

export interface OasfRecord {
  name: string;
  version: string;
  schema_version: string;
  description: string;
  authors: string[];
  created_at: string;
  locators: OasfLocator[];
  skills: OasfSkillRef[];
  domains: OasfDomainRef[];
  modules?: OasfModule[];
  annotations?: Record<string, string>;
}

export const OASF_SCHEMA_VERSION = "1.1.0";

/** Record authorship: the platform org name, as on the MCP server. */
export const OASF_RECORD_AUTHORS = ["OpenAIMP"];

/**
 * Public origin the A2A cards and the MCP endpoint are served
 * from — the same default the routes use for APP_BASE_URL
 * (src/agents/orchestrator/reportDispatch.ts et al.).
 */
export const OASF_PUBLIC_BASE_URL = "https://agent.openaimp.com";

/** The OASF v1.1.0 module class for MCP server data. */
const MCP_MODULE: { name: string; id: number } = {
  name: "integration/mcp",
  id: 202,
};

// ---------------------------------------------------------------------------
// Pinned taxonomy refs (OASF v1.1.0 catalog — see header)
// ---------------------------------------------------------------------------

const SK = {
  multiAgentCoordination: { id: 70901, name: "ai_ml_engineering/agent_orchestration/multi_agent_coordination" },
  taskDecomposition: { id: 70902, name: "ai_ml_engineering/agent_orchestration/task_decomposition" },
  multiAgentPlanning: { id: 70904, name: "ai_ml_engineering/agent_orchestration/multi_agent_planning" },
  agenticWorkflowOrchestration: { id: 70906, name: "ai_ml_engineering/agent_orchestration/agentic_workflow_orchestration" },
  ragDocumentOrDatabaseQa: { id: 70604, name: "ai_ml_engineering/retrieval_augmented_generation/document_or_database_question_answering" },
  vectorSearch: { id: 70702, name: "ai_ml_engineering/embeddings_vector_search/vector_search" },
  agentEvaluation: { id: 71002, name: "ai_ml_engineering/model_evaluation/agent_evaluation" },
  semanticUnderstanding: { id: 10102, name: "language_processing/language_understanding/semantic_understanding" },
  bookkeepingInvoicing: { id: 120201, name: "business_professional/finance_accounting/bookkeeping_invoicing" },
  financialReporting: { id: 120203, name: "business_professional/finance_accounting/financial_reporting" },
  financialPlanning: { id: 120206, name: "business_professional/finance_accounting/financial_planning" },
  equityResearch: { id: 120301, name: "business_professional/investment_trading/equity_research" },
  tradingStrategy: { id: 120302, name: "business_professional/investment_trading/trading_strategy" },
  portfolioManagement: { id: 120303, name: "business_professional/investment_trading/portfolio_management" },
  paymentsIntegration: { id: 120304, name: "business_professional/investment_trading/payments_integration" },
  regulatedFinanceOperations: { id: 120305, name: "business_professional/investment_trading/regulated_finance_operations" },
  webSearch: { id: 1302, name: "research_knowledge_productivity/web_search" },
  marketResearch: { id: 130301, name: "research_knowledge_productivity/market_intelligence/market_research" },
  knowledgeBaseManagement: { id: 130402, name: "research_knowledge_productivity/knowledge_management/knowledge_base_management" },
  documentConversion: { id: 130502, name: "research_knowledge_productivity/document_processing/document_conversion" },
  pdfManipulation: { id: 130503, name: "research_knowledge_productivity/document_processing/pdf_manipulation" },
  teamMessaging: { id: 130701, name: "research_knowledge_productivity/collaboration/team_messaging" },
  taskManagement: { id: 130802, name: "research_knowledge_productivity/project_task_management/task_management" },
  researchIdeation: { id: 130106, name: "research_knowledge_productivity/research/research_ideation" },
  deepResearch: { id: 130107, name: "research_knowledge_productivity/research/deep_research" },
  strategicPlanning: { id: 1504, name: "reasoning_planning/strategic_planning" },
  scriptIntegration: { id: 1703, name: "tool_use_automation/script_integration" },
  workflowAutomation: { id: 1704, name: "tool_use_automation/workflow_automation" },
  browserAutomation: { id: 1705, name: "tool_use_automation/browser_automation" },
  queryGeneration: { id: 80301, name: "data_engineering_analytics/query_engineering/query_generation" },
  webScraping: { id: 81001, name: "data_engineering_analytics/web_data_acquisition/web_scraping" },
  monitoringAlerting: { id: 90801, name: "devops_cloud_infra/observability/monitoring_alerting" },
  distributedTracing: { id: 90802, name: "devops_cloud_infra/observability/distributed_tracing" },
  logManagement: { id: 90803, name: "devops_cloud_infra/observability/log_management" },
} as const satisfies Record<string, OasfSkillRef>;

/**
 * A2A card capability → OASF skill classes. Every capability any
 * card declares must appear here; the generator throws otherwise.
 */
export const CAPABILITY_OASF_SKILLS: Record<string, OasfSkillRef[]> = {
  // orchestrator
  planning: [SK.multiAgentPlanning],
  supervision: [SK.multiAgentCoordination],
  "parallel-execution": [SK.agenticWorkflowOrchestration],
  // search
  "web-search": [SK.webSearch],
  "opportunity-hunt": [SK.marketResearch],
  // payments
  "budget-check": [SK.financialPlanning],
  "payment-process": [SK.paymentsIntegration],
  "payment-list": [SK.bookkeepingInvoicing],
  // tasks
  "task-create": [SK.taskManagement],
  "task-list": [SK.taskManagement],
  "task-update": [SK.taskManagement],
  // memory
  remember: [SK.knowledgeBaseManagement],
  recall: [SK.vectorSearch],
  // trading + screener
  "stock-screening": [SK.equityResearch],
  "options-screening": [SK.tradingStrategy],
  "stock-trading": [SK.portfolioManagement],
  "options-trading": [SK.tradingStrategy],
  "goal-screening": [SK.strategicPlanning],
  "run-history": [SK.logManagement],
  // aisearch
  "knowledge-search": [SK.ragDocumentOrDatabaseQa],
  // scheduled
  "goal-list": [SK.workflowAutomation],
  "goal-manage": [SK.workflowAutomation],
  "goal-trigger": [SK.workflowAutomation],
  "tick-history": [SK.logManagement],
  // research
  "research-runs": [SK.deepResearch],
  discovery: [SK.researchIdeation],
  "track-record": [SK.financialReporting],
  evaluation: [SK.agentEvaluation],
  // report-asset
  "pdf-generation": [SK.pdfManipulation],
  "asset-fetch": [SK.documentConversion],
  // browser + slack
  "transaction-snap": [SK.browserAutomation],
  "page-snapshot": [SK.browserAutomation],
  "dom-scraping": [SK.webScraping],
  "pre-trade-approval": [SK.regulatedFinanceOperations],
  // sandbox
  "sandbox-status": [SK.monitoringAlerting],
  "sandbox-run": [SK.scriptIntegration],
};

/**
 * Registry tool family → OASF skill classes, for the MCP server
 * record. Only families that own McpToolFactory catalog tools
 * belong here (mcpCommandOwners()); a catalog tool whose family is
 * missing here fails generation loudly.
 */
export const MCP_FAMILY_OASF_SKILLS: Record<string, OasfSkillRef[]> = {
  "core-mcp-commands": [
    SK.ragDocumentOrDatabaseQa,
    SK.paymentsIntegration,
    SK.queryGeneration,
    SK.semanticUnderstanding,
    SK.financialReporting,
  ],
  "cloudflare-agent-mcp-commands": [
    SK.browserAutomation,
    SK.workflowAutomation,
    SK.scriptIntegration,
    SK.tradingStrategy,
    SK.regulatedFinanceOperations,
    SK.ragDocumentOrDatabaseQa,
  ],
  "etrade-mcp-commands": [
    SK.equityResearch,
    SK.tradingStrategy,
    SK.portfolioManagement,
  ],
  "agentic-payment-mcp-commands": [
    SK.paymentsIntegration,
    SK.equityResearch,
    SK.marketResearch,
  ],
  "goal-chain-mcp-commands": [
    SK.taskDecomposition,
    SK.strategicPlanning,
    SK.workflowAutomation,
  ],
  "market-data-mcp-commands": [
    SK.marketResearch,
    SK.equityResearch,
    SK.portfolioManagement,
    SK.tradingStrategy,
  ],
  "agentdb-read-mcp-commands": [
    SK.queryGeneration,
    SK.logManagement,
    SK.distributedTracing,
  ],
  "mesh-door-mcp-commands": [
    SK.multiAgentCoordination,
    SK.workflowAutomation,
    SK.tradingStrategy,
    SK.paymentsIntegration,
    SK.taskManagement,
    SK.pdfManipulation,
    SK.browserAutomation,
    SK.teamMessaging,
    SK.regulatedFinanceOperations,
  ],
};

/** A2A card name → OASF domain class (v1.1.0 domains catalog). */
export const CARD_OASF_DOMAINS: Record<string, OasfDomainRef> = {
  orchestrator: { id: 11107, name: "technology/artificial_intelligence/ai_agents" },
  search: { id: 208, name: "finance_and_business/capital_markets" },
  payments: { id: 207, name: "finance_and_business/payments" },
  tasks: { id: 112, name: "technology/productivity_collaboration" },
  memory: { id: 111, name: "technology/artificial_intelligence" },
  trading: { id: 208, name: "finance_and_business/capital_markets" },
  aisearch: { id: 111, name: "technology/artificial_intelligence" },
  screener: { id: 203, name: "finance_and_business/investment_services" },
  scheduled: { id: 110, name: "technology/process_automation" },
  research: { id: 203, name: "finance_and_business/investment_services" },
  "report-asset": { id: 106, name: "technology/information_technology" },
  browser: { id: 106, name: "technology/information_technology" },
  slack: { id: 112, name: "technology/productivity_collaboration" },
  sandbox: { id: 102, name: "technology/software_engineering" },
};

const SERVER_OASF_DOMAINS: OasfDomainRef[] = [
  { id: 202, name: "finance_and_business/finance" },
  { id: 11107, name: "technology/artificial_intelligence/ai_agents" },
];

// ---------------------------------------------------------------------------
// Mapping resolvers — the loud-failure seam
// ---------------------------------------------------------------------------

export function oasfSkillsForCapability(capability: string): OasfSkillRef[] {
  const skills = CAPABILITY_OASF_SKILLS[capability];
  if (!skills || skills.length === 0) {
    throw new Error(
      `oasf: unmapped agent-card capability "${capability}" — add it to CAPABILITY_OASF_SKILLS in src/services/oasfRecords.ts`,
    );
  }
  return skills;
}

export function oasfSkillsForMcpTool(toolName: string): OasfSkillRef[] {
  const familyId = mcpCommandOwners().get(toolName);
  if (!familyId) {
    throw new Error(
      `oasf: unmapped MCP tool "${toolName}" — no owning family in MESH_TOOL_FAMILIES (registry drift)`,
    );
  }
  const skills = MCP_FAMILY_OASF_SKILLS[familyId];
  if (!skills || skills.length === 0) {
    throw new Error(
      `oasf: unmapped MCP tool family "${familyId}" (tool "${toolName}") — add it to MCP_FAMILY_OASF_SKILLS in src/services/oasfRecords.ts`,
    );
  }
  return skills;
}

// ---------------------------------------------------------------------------
// Generation
// ---------------------------------------------------------------------------

export interface OasfGenerationOptions {
  /**
   * RFC 3339 timestamp stamped on every record. Supplied by the
   * caller — never read from the wall clock — so generation is a
   * pure function of (sources, createdAt): the same inputs produce
   * byte-identical records. A publication slice (owner-scoped,
   * later) stamps the real time at publish.
   */
  createdAt: string;
}

const RFC3339_RE =
  /^\d{4}-\d{2}-\d{2}T\d{2}:\d{2}:\d{2}(\.\d+)?(Z|[+-]\d{2}:\d{2})$/;

function assertCreatedAt(createdAt: string): void {
  if (!RFC3339_RE.test(createdAt)) {
    throw new Error(
      `oasf: createdAt must be an RFC3339 timestamp, got "${createdAt}"`,
    );
  }
}

function dedupeSortSkills(skills: OasfSkillRef[]): OasfSkillRef[] {
  const byId = new Map<number, OasfSkillRef>();
  for (const skill of skills) {
    const existing = byId.get(skill.id);
    if (existing && existing.name !== skill.name) {
      throw new Error(
        `oasf: skill id ${skill.id} maps to two names ("${existing.name}", "${skill.name}")`,
      );
    }
    byId.set(skill.id, skill);
  }
  return [...byId.values()].sort((a, b) => a.id - b.id);
}

export function buildAgentOasfRecord(
  card: AgentCard,
  opts: OasfGenerationOptions,
): OasfRecord {
  assertCreatedAt(opts.createdAt);
  const surface = MESH_SURFACES.find((s) => s.name === card.name);
  if (!surface || !surface.card) {
    throw new Error(
      `oasf: no card-carrying registry surface for agent card "${card.name}"`,
    );
  }
  const domain = CARD_OASF_DOMAINS[card.name];
  if (!domain) {
    throw new Error(
      `oasf: unmapped domain for agent card "${card.name}" — add it to CARD_OASF_DOMAINS in src/services/oasfRecords.ts`,
    );
  }
  const identity = getIdentityRecord(surface.ownerClass);
  const annotations: Record<string, string> = {
    "openaimp.surface": card.name,
    "openaimp.owner_class": surface.ownerClass,
  };
  // The class DID is carried only when the registry records one;
  // a class without a DID gets no annotation rather than an
  // invented identity (S16 posture).
  if (identity?.did) annotations["openaimp.did"] = identity.did;
  return {
    name: card.name,
    version: card.version,
    schema_version: OASF_SCHEMA_VERSION,
    description: card.description,
    authors: [...OASF_RECORD_AUTHORS],
    created_at: opts.createdAt,
    locators: [
      {
        type: "url",
        urls: [
          `${OASF_PUBLIC_BASE_URL}${card.cardPath}`,
          `${OASF_PUBLIC_BASE_URL}${card.endpoint}`,
        ],
      },
    ],
    skills: dedupeSortSkills(
      card.capabilities.flatMap((c) => oasfSkillsForCapability(c)),
    ),
    domains: [domain],
    annotations,
  };
}

export function buildMcpServerOasfRecord(
  opts: OasfGenerationOptions,
): OasfRecord {
  assertCreatedAt(opts.createdAt);
  const tools = [...MCP_TOOLS]
    .sort((a, b) => (a.name < b.name ? -1 : a.name > b.name ? 1 : 0))
    .map((t) => ({ name: t.name, description: t.description }));
  return {
    name: MCP_SERVER_INFO.name,
    version: MCP_SERVER_INFO.version,
    schema_version: OASF_SCHEMA_VERSION,
    description: MCP_SERVER_INFO.description,
    authors: [...OASF_RECORD_AUTHORS],
    created_at: opts.createdAt,
    locators: [
      { type: "url", urls: [`${OASF_PUBLIC_BASE_URL}/mcp`] },
    ],
    skills: dedupeSortSkills(
      MCP_TOOLS.flatMap((t) => oasfSkillsForMcpTool(t.name)),
    ),
    domains: [...SERVER_OASF_DOMAINS],
    modules: [
      {
        name: MCP_MODULE.name,
        id: MCP_MODULE.id,
        data: {
          name: MCP_SERVER_INFO.name,
          description: MCP_SERVER_INFO.description,
          tools,
          connections: [
            {
              type: "streamable-http",
              url: `${OASF_PUBLIC_BASE_URL}/mcp`,
            },
          ],
        },
      },
    ],
    annotations: {
      "openaimp.mcp_server": MCP_SERVER_INFO.name,
      "openaimp.tool_count": String(MCP_TOOLS.length),
    },
  };
}

export interface OasfRecordSet {
  agents: OasfRecord[];
  server: OasfRecord;
}

export function generateOasfRecords(
  opts: OasfGenerationOptions,
): OasfRecordSet {
  assertCreatedAt(opts.createdAt);
  return {
    agents: AGENT_CARDS.map((card) => buildAgentOasfRecord(card, opts)),
    server: buildMcpServerOasfRecord(opts),
  };
}

// ---------------------------------------------------------------------------
// Structural validation against the v1.1.0 record contract
// ---------------------------------------------------------------------------

const KNOWN_SKILL_REFS = new Set(
  [
    ...Object.values(CAPABILITY_OASF_SKILLS).flat(),
    ...Object.values(MCP_FAMILY_OASF_SKILLS).flat(),
  ].map((s) => `${s.id}:${s.name}`),
);

const KNOWN_DOMAIN_REFS = new Set(
  [...Object.values(CARD_OASF_DOMAINS), ...SERVER_OASF_DOMAINS].map(
    (d) => `${d.id}:${d.name}`,
  ),
);

/**
 * Validate one record against the OASF v1.1.0 record contract
 * (schema/objects/record.json): required fields present and
 * well-formed, created_at RFC 3339, and every skill/domain ref
 * drawn from the pinned v1.1.0 taxonomy tables above — never free
 * text. Returns the list of violations (empty = valid).
 */
export function validateOasfRecord(record: OasfRecord): string[] {
  const errors: string[] = [];
  const fail = (msg: string) => errors.push(msg);

  if (!record || typeof record !== "object") return ["record is not an object"];
  if (!record.name) fail("name is required");
  if (!record.version) fail("version is required");
  if (!record.schema_version) fail("schema_version is required");
  else if (record.schema_version !== OASF_SCHEMA_VERSION) {
    fail(
      `schema_version must be the pinned ${OASF_SCHEMA_VERSION}, got ${record.schema_version}`,
    );
  }
  if (!record.description) fail("description is required");
  if (!Array.isArray(record.authors) || record.authors.length === 0) {
    fail("authors is required and must be a non-empty array");
  } else if (record.authors.some((a) => !a)) {
    fail("authors entries must be non-empty strings");
  }
  if (!record.created_at) fail("created_at is required");
  else if (!RFC3339_RE.test(record.created_at)) {
    fail(`created_at must be RFC3339, got ${record.created_at}`);
  }
  if (!Array.isArray(record.skills) || record.skills.length === 0) {
    fail("skills is required and must be a non-empty array");
  } else {
    for (const skill of record.skills) {
      if (!Number.isInteger(skill.id) || skill.id <= 0) {
        fail(`skill id must be a positive integer, got ${skill.id}`);
      }
      if (!skill.name) fail("skill name is required");
      else if (!KNOWN_SKILL_REFS.has(`${skill.id}:${skill.name}`)) {
        fail(
          `skill ${skill.id}:${skill.name} is not in the pinned OASF v1.1.0 mapping tables`,
        );
      }
    }
  }
  if (record.domains !== undefined) {
    if (!Array.isArray(record.domains)) fail("domains must be an array");
    else {
      for (const domain of record.domains) {
        if (!KNOWN_DOMAIN_REFS.has(`${domain.id}:${domain.name}`)) {
          fail(
            `domain ${domain.id}:${domain.name} is not in the pinned OASF v1.1.0 mapping tables`,
          );
        }
      }
    }
  }
  if (record.locators !== undefined) {
    if (!Array.isArray(record.locators)) fail("locators must be an array");
    else {
      for (const locator of record.locators) {
        if (!locator.type) fail("locator type is required");
        if (!Array.isArray(locator.urls) || locator.urls.length === 0) {
          fail("locator urls must be a non-empty array");
        } else if (
          locator.urls.some((u) => !/^https?:\/\//.test(u))
        ) {
          fail(`locator urls must be absolute http(s) URLs: ${locator.urls}`);
        }
      }
    }
  }
  if (record.modules !== undefined) {
    if (!Array.isArray(record.modules)) fail("modules must be an array");
    else {
      for (const mod of record.modules) {
        if (!mod.name || !Number.isInteger(mod.id) || mod.id <= 0) {
          fail("module name and positive integer id are required");
        }
        if (mod.name === MCP_MODULE.name && mod.id !== MCP_MODULE.id) {
          fail(`module ${MCP_MODULE.name} must carry id ${MCP_MODULE.id}`);
        }
      }
    }
  }
  return errors;
}
