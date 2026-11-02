### Bootstrap store operator (interim, owner-directed)

- `COMMERCIAL_STORE_OPERATORS` set to `OpenAIMP` in `wrangler.jsonc` vars (issue #2800): the owner login becomes a store operator on the next production deploy, unblocking the operator-gated commercial reads. Interim bootstrap only — the durable operator list is managed through the UI once an operator exists, and this entry can be removed by a follow-up PR + redeploy. No code changes.
