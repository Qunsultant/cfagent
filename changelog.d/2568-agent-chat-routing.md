### Fixed

- Copilot chat route fixed (#2568): the chat tab now addresses the existing SEARCH_AGENT Durable Object binding (`/agents/search-agent/<login>`) instead of `/agents/orchestrator-agent/<login>`, which matched no binding and failed every chat turn before any model call. Instance name and DO state are unchanged (same SEARCH_AGENT namespace, same idFromName(login)); no binding was added or renamed, no workflow files touched, no deletions.
