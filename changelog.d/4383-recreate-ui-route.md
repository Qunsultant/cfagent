### Added

- **Data Lifecycle recreate (#4383):** rebuild schema + seeds from the Platform Admin UI's Data Lifecycle section (preview → confirm → audit). A second run is a no-op report; layers that cannot be recreated (Vectorize re-index, corpus bytes, queues, AI Search index, R2 contents) are reported with reasons, never faked. The recreate report is downloadable from the panel.
