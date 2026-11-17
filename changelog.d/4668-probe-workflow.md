### Added
- Add manual `workflow_dispatch` workflow (`.github/workflows/probe-public-mcp-schema.yml`) using `PROD` environment secret `PUBLIC_API_KEY` to probe `https://mcp.public.com/mcp` (`tools/list`), write `/tmp/public-mcp-schema.json`, and upload it as an artifact for #4668 verification.
