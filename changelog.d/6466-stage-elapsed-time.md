### Research

- **OODA runs are diagnosable from dispatch (#6466):** every stage shows its elapsed time (finished: recorded duration; running: live tick; timed-out/failed: start-to-end), the dispatch stamps the workflow instance id on the run record (state `idle`), the settlement wait and per-stage timeouts are externalized (stored research config over deployment carriers over defaults), and step spans/logs carry the run id as a first-class field so a run is findable in Grafana by run id.
