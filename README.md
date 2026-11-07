# AI Multi-Agent Assistant — Cloudflare Agents SDK

An enterprise multi-agent assistant built with the Cloudflare Agents SDK, Workers AI, and Cloudflare AI Search. Features an **LLM Judge** router, specialized sub-agent tools (RAG Search, Payment Intent Drafting, Task Drafting, and Durable SQLite Memory), streaming WebSocket responses, and a read-only **Natural Language Query (NLQ)** analytics engine.

## Key Capabilities

| Feature | Description |
|---|---|
| **Multi-Agent Orchestrator** | Coordinates specialized sub-agent tools dynamically based on user intent |
| **LLM Judge & Router** | Classifies user intent (`search`, `payments`, `tasks`, `memory`, `general`) with confidence scoring, and evaluates response quality/safety in real-time |
| **Knowledge Base Search** | RAG retrieval from Cloudflare AI Search with citation metadata |
| **Safe Payment Drafting** | Drafts charges, refunds, and invoices with human-in-the-loop confirmation guardrails; never executes unverified money movement |
| **Task Management** | Proposes and organizes actionable tasks with priorities and deadlines |
| **Durable SQLite Memory** | Key-value fact vault persisted natively inside Durable Object SQLite storage across sessions |
| **Read-Only NLQ Engine** | Converts natural language analytics queries into parameter-bound SQLite queries over conversation transcripts |
| **Cross-Channel Trading Research** | Export loaded market data and options research, screen evaluations, strategy evaluations, and recommendations as `.xlsx`; email workbooks, submit NLQ through Slack or voice, and publish signed recommendation reports to the configured webhook |
| **Enterprise Security** | Constant-time HMAC OAuth state verification with replay protection, Cross-Site WebSocket Hijacking (CSWSH) origin validation, and XSS-safe user script injection |

## Architecture

```
Browser (React 19 + Vite) 
    │
    ├─ WebSocket ──► OrchestratorAgent (Durable Object)
    │                  ├─ LLM Judge (Intent Routing & Evaluation)
    │                  ├─ Workers AI (glm-4.7-flash)
    │                  ├─ Cloudflare AI Search (RAG Tool)
    │                  └─ DO SQLite Tables (mas_messages, mas_events, mas_memory)
    │
    └─ REST APIs ──► Worker Fetch Handler
                       ├─ /auth/* (GitHub OAuth 2.0)
                       ├─ /api/nlq (Natural Language Transcript Analytics)
                       ├─ /api/audit (Real-time Event Log)
                       └─ /api/memory (Persistent Memory Vault)
```

## Setup & Deployment

### Shared NLQ channel routing

Web chat (`/api/nlq`), Slack messages, voice transcripts, and inbound email use the same NLQ planner and executor. A Slack message can request an email copy by including an explicit recipient, for example `@ETradeAgent screen stocks; email results to analyst@example.com`. Slack replies in the originating channel/thread; when configured, the same structured result is also sent to `OUTBOUND_WEBHOOK_URL` with an HMAC signature. State-changing order actions are not copied to these report destinations.

Signed external NLQ requests can POST JSON to `/nlq/webhook` with an `X-Signature-256: sha256=<hex>` header computed as HMAC-SHA256 over the exact request body using `INBOUND_NLQ_WEBHOOK_SECRET`:

```json
{ "query": "list all strategies evaluated for NVDA bullish target $260", "emailTo": "analyst@example.com", "timestamp": "2026-10-03T15:00:00.000Z" }
```

Sign the exact JSON request body with HMAC-SHA256 and send its hex digest as `X-Signature-256: sha256=<hex>`. The signed `timestamp` must be within five minutes of receipt. `emailTo` is optional and must be supplied explicitly. Webhook requests receive the shared NLQ result as JSON; email delivery requires the existing Cloudflare `EMAIL` binding.

### 1. Add GitHub Secrets
Set the following in **Settings → Secrets and variables → Actions**:

| Secret Name | Value |
|---|---|
| `CF_API_TOKEN` | Cloudflare API Token with Workers, Routes, and DNS Edit permissions |
| `CF_ACCOUNT_ID` | Your Cloudflare Account ID |
| `GH_CLIENT_ID` | GitHub OAuth App Client ID |
| `GH_CLIENT_SECRET` | GitHub OAuth App Client Secret |
| `APP_BASE_URL` | Application URL (e.g. `https://agent.openaimp.com`) |
| `SESSION_SECRET` | 32-byte hex secret (`openssl rand -hex 32`) |

### 2. GitHub OAuth App Configuration
In GitHub Developer Settings:
- **Homepage URL**: `https://<your-worker-domain>`
- **Callback URL**: `https://<your-worker-domain>/auth/callback`

### 3. Local Development
```bash
npm install
npm run dev        # Starts Vite dev server for frontend
npx wrangler dev   # Runs Cloudflare Worker + Durable Objects locally
```

Create a `.dev.vars` file for local development:
```ini
GITHUB_CLIENT_ID=your_client_id
GITHUB_CLIENT_SECRET=your_client_secret
APP_BASE_URL=http://localhost:8787
SESSION_SECRET=your_random_secret_string
```

### 4. Build & Typecheck
```bash
npm run typecheck  # Validates TypeScript types (0 errors)
npm run build      # Bundles production React app with Vite
npm run check      # Runs both typecheck and build
```

## Project Structure

```
ai-search-agent/
├── src/
│   ├── server.ts           # Worker entry point & DO routing
│   ├── types.ts            # Domain types (Env, Session, Audit, NLQ)
│   ├── session.ts          # Session management & constant-time HMAC
│   ├── oauth.ts            # GitHub OAuth flow & glassmorphic pages
│   ├── agents/
│   │   ├── orchestrator.ts # Master Orchestrator DO (SQLite, streaming, APIs)
│   │   ├── judge.ts        # LLM Judge (routing & response evaluation)
│   │   ├── mas.ts          # Unified sub-agent tools (search, payments, tasks, memory)
│   │   ├── nlq.ts          # Natural Language Query planner & SQLite executor
│   │   ├── search.ts       # Standalone Knowledge Search agent
│   │   ├── payments.ts     # Standalone Payment Drafting agent
│   │   ├── tasks.ts        # Standalone Task Drafting agent
│   │   └── memory.ts       # Standalone Memory agent
│   └── client/
│       ├── main.tsx        # React 19 entry
│       ├── Chat.tsx        # Multi-tab UI (Chat, NLQ Analytics, Inspector)
│       └── styles.css      # Dark-mode glassmorphic design system
├── wrangler.jsonc          # Worker, DO SQLite migration, KV & AI bindings
├── vite.config.ts          # Vite configuration
└── package.json            # Scripts & dependencies
```

## Releases

This project keeps a [CHANGELOG.md](./CHANGELOG.md) in Keep a Changelog format.

- Every change lands under `## [Unreleased]` as it merges.
- A release is a PR that moves those entries into a versioned
  `## [X.Y.Z] - YYYY-MM-DD` section; the tag `vX.Y.Z` is placed on the
  release PR's merge commit afterward. See the CHANGELOG header for the
  full tagging convention.
