### Fixed

- **Scheduled options alerts now name the owner and always render the schedule (#5232):** the 23:35Z alert could not answer "whose run is this" or "which schedule do I pause" — it named neither, and the run carried no schedule id at all. The context line now always includes `owner <login>` and `schedule <id|unknown>`, so an unattributed run is visible as such instead of silently omitting the field.
