### Options sharded chain on the one engine (#4780)

- The options sharded chain now dispatches as one engine job `options-chain:<chainId>` through `startOptionsChainWorkflow`; the bespoke `shardSubmit` port, `planOptionsFeedShards`, and `applyShardPacing` are removed.
- The feed node's sharded shape with sequential units is the pacing: each per-symbol unit is its own journaled workflow step with its own subrequest budget. A feed unit that cannot resolve its chain source is a per-symbol failed outcome, never a throw; a renderer that cannot run is a per-format failed outcome.
- New pin `tests/options_chain_engine_4780.test.ts` (wired into `test:pins`) asserts no second chain-start path remains.
- Known gaps: the engine path does not write the serve-record summary row (a follow-up sub-issue under #4780 is prepared); the chain job is not in `workflowCatalog`; #4423 retry lineage is not carried in the canonical body (the step journal is the retry record).
