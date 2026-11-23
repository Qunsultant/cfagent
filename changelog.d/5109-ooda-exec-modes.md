### Fixed

- OODA research job now runs on the resilient exec-mode combination: sequential / batch / async / monolith / durable (durability made explicit on the spec), with per-stage deadlines and retry buckets from the one config home — feed 240s with the acquisition bucket, analyze/enrich/generate/evaluate 600s with the report bucket, deliver 300s with the delivery bucket.
- Per-stage research timeouts and retry buckets are externalized in `researchJobConfig.ts` (`RESEARCH_STAGE_TIMEOUTS_MS` / `RESEARCH_STAGE_RETRY_BUCKETS` env carriers), so an operator can retune a stage without editing code.
