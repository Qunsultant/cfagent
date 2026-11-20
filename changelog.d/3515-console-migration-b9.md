### Standards conformance

- **#3515 S3 batch 9**: migrated 21 unstructured `console.*` call sites across 2 files in `src/events` to the S2 structured logger (`createStructuredLogger`), severity preserved, no behavior change; remaining unstructured sites now 20.
