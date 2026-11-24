### Each OODA report records the resolved rules, not only the version (#6037 d)

- `ResearchReport.rules` carries the resolved `ResearchRules` a run decided under — the same block the pipeline read (one resolution), so a report is reproducible from its own evidence instead of "current settings".
- The report's data rows gain a canonical `rules` row (every rule, sorted keys) beside `rules_version`; the PDF prints the values under the version line.
- Behaviour-neutral: a default run records exactly the declared defaults; a stored override appears in the report while `rulesVersion` stays what the config names.
