# FOSS Data Platform Catalog — Research Report

**Researched:** 2026-11-24. **Scope:** open-source (FOSS) libraries/tools for data cataloguing, lineage, quality and discoverability, judged against a TypeScript/Cloudflare Workers + D1 (SQLite over HTTP, Drizzle ORM) + Durable Objects + R2 stack, OLTP, ≥3NF, zero denormalization, D1-first, dockerized, vendor-agnostic, one framework per job, best FOSS over custom code.
**Keep:** Drizzle ORM, Zod, Hono (+ chanfana), MCP TypeScript SDK, React 19 + Vite 6.
**Custom code to replace:** hand-rolled DDL/DML catalogues in TS with pin tests; hand-written validators; planned in-app read-only DataStudio viewer (in-code product registry); no lineage, no DQ framework, no metadata catalog, no schema registry.

**Confidence key:** `verified live` = read directly in this session; `index` = from search-result text (secondary sources, mostly Nov 2026 round-ups that cite project docs/repos). Version claims are as of Nov 2026.

## Summary

The headline finding: **no full FOSS data catalog fits this stack as-is.** Every established catalog (DataHub, OpenMetadata, Apache Atlas) requires a Java server plus a relational store it does not share with D1 (MySQL/Postgres) plus a search cluster (Elasticsearch/OpenSearch/Solr), and DataHub additionally requires Kafka; none runs on SQLite/D1 and none has a D1 connector. Amundsen, the lightest of the old guard, was **archived in September 2026 — do not adopt it**.

The tools that *do* fit are the small, composable, library/CLI-shaped ones — and they map almost 1:1 onto the custom code to be replaced:

1. **DuckDB** (MIT, embedded) for analytical query over Parquet in R2 — the discovery/query layer.
2. **Data Contract CLI** (MIT, ODCS) for machine-readable data contracts tested in CI — replaces hand-written validators.
3. **OpenLineage, client-only** (Apache 2.0, plain JSON events emitted from TypeScript, stored in D1) for lineage — no server required; **Marquez** (Apache 2.0, Java + Postgres) is the optional dockerized viewer later.
4. **GX Core** (Apache 2.0, Python) for data-quality checks run in CI/sidecar against exported snapshots — replaces hand-written validators at the dataset level.
5. **ODD Platform** (Apache 2.0, Java + Postgres only) is the *only* full catalog that fits as a single dockerized sidecar — defer it until the catalog outgrows D1 tables; **Datasette** (Apache 2.0) is the lighter alternative for the DataStudio viewer on snapshots.

Two 2026 license changes matter for any "FOSS only" policy: **Soda Core moved Apache 2.0 → Elastic License 2.0 (Jan 2026, source-available, not OSI open source)** and **Liquibase Community moved Apache 2.0 → Functional Source License in 5.0 (late 2025, not OSI)**. Both are flagged, not recommended as FOSS. Also: **GX Cloud was discontinued 1 June 2026** (FICO acquired it; Fivetran now stewards GX Core) and **Ariga Atlas's default binary is now under a proprietary MSA** (community build remains Apache 2.0).

**One structural caveat (analysis, not a tool fact):** D1 is SQLite reached over HTTP via Drizzle — there is no local SQLite file and no wire protocol for GX, Soda, dbt-sqlite, Datasette or DuckDB to attach to directly. Every SQL-engine-based quality/discovery tool below can therefore only run against an **exported snapshot** (D1 → SQLite file or Parquet in R2) or via a sidecar that pulls through the app's HTTP API. This is the single biggest fit constraint in the whole report, and it is why the recommended pattern is: **metadata of record lives in D1 tables (Drizzle + Zod); heavy tools run outside, on snapshots.**

## Findings

### 1. Data catalog / metadata management

| Tool | License | Language/runtime | Backend services required | SQLite / D1? |
|---|---|---|---|---|
| **DataHub** (LinkedIn/Acryl) | Apache 2.0 (`index`) | Java (GMS) + React frontend, Python ingestion | Kafka (+ schema registry), Elasticsearch or OpenSearch, MySQL or Postgres, optional Neo4j; 7+ containers; quickstart needs 2 CPU / 8 GB RAM; K8s/Helm for prod | No — metadata store is MySQL/Postgres only; no D1/SQLite connector; ingestion would be custom via REST/GraphQL API |
| **OpenMetadata** (Collate) | Apache 2.0 at repo root, **but ingestion and UI folders under Collate Community License 1.0** (`index` — read both before building on it) | Java server (Dropwizard), Python ingestion, React UI | MySQL 8.0.42+ or Postgres 15+; Elasticsearch 9.3+ or OpenSearch 3.4+ (search cluster: ≥1 master + 2 workers); Airflow or K8s-native orchestrator for ingestion; min sizing DB 4 vCPU/16 GiB | No — same as DataHub; no SQLite/D1 backend |
| **Amundsen** (Lyft, LF AI & Data) | Apache 2.0 | Python/Flask + React | Neo4j (or Atlas) metadata store + Elasticsearch search + databuilder ingestion | No — and **ARCHIVED Sept 2026** (repo archived 10 Sept 2026; last releases 2024). Do not adopt. |
| **Apache Atlas** | Apache 2.0 | Java | JanusGraph/HBase + Solr + Kafka + ZooKeeper; Hadoop-native hooks (Hive, HBase, Sqoop) | No — Hadoop-centric; heaviest option here |
| **ODD Platform** (Open Data Discovery) | Apache 2.0 | Java/Spring + React | **PostgreSQL only** (one container + Postgres); lightweight collector agents push via REST; no Kafka, no search cluster | As a *source* it lists SQLite and DuckDB; its own store is Postgres, not D1. Lightest full catalog found. v0.29.0 (26 Jun 2026). |
| **Unity Catalog OSS** (Databricks, LF AI & Data) | Apache 2.0 (API + server) | Java server | PostgreSQL metadata DB; S3-compatible storage; Delta/Iceberg tables | No — lakehouse catalog, not an OLTP/table catalog; OSS 0.7.0 (Oct 2026), APIs still evolving; lineage, DQ monitoring and ABAC are managed-service features / roadmap only |
| **CKAN** | Not verified in this research (not stated) | Python/Flask | PostgreSQL + Apache Solr + Redis | No — dataset-*publishing* portal (data.gov etc.), not a table/column catalog |
| **Magda** | Apache 2.0 | K8s microservices (mixed) | Elasticsearch, K8s/Helm | No — federated public-data catalog |
| **Datasette** | Apache 2.0 (`index`) | Python 3.10+ (ASGI) | None — serves a SQLite file as browsable UI + JSON API; single container; 150+ plugins | **Yes, natively — but only a local SQLite *file*, not D1 over HTTP.** Fits as a sidecar on exported snapshots. 0.65.x stable / 1.0 alpha (2026). |
| **Egeria** (ODPi/LF AI & Data) | Apache 2.0 | Java (OMAG servers) | Kafka-based metadata exchange; governance-heavy | No — not deeply verified; governance framework, not a lightweight catalog |

Sources: DataHub — https://atlan.com/open-source-data-catalog-tools/, https://fastero.com/blog/datahub-vs-openmetadata-open-source-data-catalogs, https://panoply.io/tools/datahub/ · OpenMetadata — https://www.deployopen.com/open-source/openmetadata, https://atlan.com/know/data-catalog/best-data-catalog-small-teams-vs-enterprises/, https://stackscape.org/en/p/openmetadata/ · Amundsen — https://atlan.com/amundsen-vs-datahub/, https://datastackindex.com/data-governance/tools/amundsen/ · Atlas — https://www.nfpstack.com/docs/benchmarks/data-catalogue-and-governance/, http://zairalabs.ai/guide/tools/apache-atlas/ · ODD — https://www.softono.com/software/odd-platform, https://dev.co/observability/open-source/odd-platform · Unity Catalog — https://answers.databricks.com/unity-catalog-open-source, https://codewithsql.com/compare/unity-catalog-vs-snowflake-horizon · CKAN — https://www.ckan.org/faq/technical · Magda — https://medevel.com/magda-bigdata/ · Datasette — https://dev.co/databases/open-source/datasette, https://www.everydev.ai/tools/datasette. All `index`, 2026-11-24.

**Catalog conclusion:** the "big three" are warehouse/lakehouse products. For a D1-first OLTP system the catalog of record should be **D1 tables defined in Drizzle** (the hand-rolled catalogue, but formalised: dataset/table/column/owner/glossary tables + Zod-validated registry), surfaced by the existing React frontend — not a second metadata database. A packaged catalog only becomes worth its Postgres+search-cluster cost when ingestion from many external sources is needed; at that point ODD Platform is the least-bad sidecar.

### 2. Data lineage

| Option | License | What it is / runtime | Server needed? |
|---|---|---|---|
| **OpenLineage (spec + clients)** | Apache 2.0 | Open standard (LF AI & Data, graduated): a `RunEvent` JSON format (job/run/input-output datasets + facets). Official Python and Java clients; transports HTTP, Kafka, **File, Console** (no config defaults to Console — events just print). **No official TypeScript client was found in this research** — but the event is plain JSON, so a TS Worker can emit it with `fetch`/a file write and no SDK. | **No — client-only emission is a first-class mode.** Events can be written to a file / R2 / a D1 `lineage_events` table and consumed later. |
| **Marquez** (OpenLineage reference backend) | Apache 2.0 — `verified live` via https://github.com/MarquezProject/marquez (2026-11-24) | Java 17 + **PostgreSQL 14**; Docker quickstart (`./docker/up.sh`); HTTP API :5000, admin :5001, web UI :3000; **no auth by default**; 0.50.0 RECOMMENDED, OpenLineage 2-0-2 | Yes, but small: Java API + Postgres + web UI (docker-compose). Secondary source notes **no release since Oct 2024** — watch cadence. |
| **sqllineage** | MIT | Python library/CLI; statically parses SQL (sqlfluff/sqlparse) into table- and column-level lineage graphs (networkx); v1.5.8 (16 May 2026) | **No server.** Static analysis only — no runtime lineage, no dynamic SQL; effectively single-maintainer. |
| **SQLGlot** (`lineage`) | MIT | Python, dependency-free parser/transpiler, 30+ dialects; `lineage()` builds a column graph from SQL + schema | **No server.** Library, not a lineage system. |
| DataHub / OpenMetadata lineage | Apache 2.0 (see §1) | Column-level lineage inside the catalog platforms | Yes — inherits the full catalog stack (§1). DataHub lineage can also *consume* OpenLineage events. |
| dbt lineage | Apache 2.0 | Derived from `manifest.json` (model DAG); column lineage via SQL parsing | No server, but needs a dbt project (§3). |

Sources: OpenLineage client config — https://github.com/openlineage/openlineage-site/blob/HEAD/versioned_docs/version-1.42.1/client/python/configuration.md · Marquez — https://github.com/MarquezProject/marquez (`verified live`), https://datastackindex.com/data-governance/tools/marquez/ · sqllineage/SQLGlot — https://dev.co/databases/open-source/sqllineage, https://datadriven.io/data-lineage-tools, https://stackscape.org/en/vs/sqlglot-vs-sqllineage/.

**Lineage conclusion:** the lightweight answer exists and is standardised — **emit OpenLineage JSON from the Workers/Durable Objects that already know producer → consumer relationships, persist the events in D1, and render the graph in the existing React app**. That replaces "no lineage tracking" with zero new infrastructure. sqllineage/SQLGlot in CI covers lineage *derived from SQL text* (e.g. from Drizzle-generated SQL or migration files). Marquez is the upgrade path when a standalone lineage UI/API is wanted; it is the smallest lineage server available.

### 3. Data quality and data contracts

| Tool | License | Runtime | SQLite / D1? |
|---|---|---|---|
| **GX Core (Great Expectations)** | Apache 2.0 | Python 3.10–3.14 library; Expectations → SQL/pandas/Spark execution; Checkpoints, Data Docs HTML reports; Airflow 2.9+ only officially supported orchestrator | **SQLite is a listed supported source** — but via SQLAlchemy against a SQLite *file*, not D1 over HTTP. Run in CI/sidecar against an exported snapshot. v1.24.1 (22 Oct 2026); 1.25.0 also reported. **GX Cloud discontinued 1 June 2026** (acquired by FICO); **Fivetran stewards GX Core from May 2026**. |
| **Soda Core** | **Elastic License 2.0 since v4 (Jan 2026) — source-available, NOT OSI open source** (v3 was Apache 2.0; v3 line ended Sept 2025) | Python CLI/library; YAML data contracts, 50+ built-in checks, compiled to SQL in-source; v4.30.0 (5 Nov 2026); anomaly detection/alerting in proprietary Soda Cloud | Supports Postgres, Snowflake, BigQuery, Databricks, **DuckDB**, Redshift, Athena, Trino, Spark — **SQLite not listed**. Via DuckDB it could check exported files. **Excluded from the FOSS shortlist on license grounds** (fine for internal use, but fails a strict FOSS-only policy). |
| **dbt tests (+ dbt-expectations)** | Apache 2.0 (dbt Core) | Python; a test is a SQL query returning violating rows (`unique`, `not_null`, `accepted_values`, `relationships`, singular/generic tests); `dbt test` | **dbt-sqlite adapter exists** (aligned to dbt-core, 1.10.x Jun 2025) but self-described **experimental**, single-threaded, snapshots need the SQLean `crypto` extension. Warehouse-oriented; only viable on a snapshot, and it drags in a dbt project model that duplicates Drizzle's. dbt Labs was acquired by Fivetran (June 2026). |
| **Data Contract CLI** (`datacontract`) | MIT — `verified live` via https://cli.datacontract.com/ (2026-11-24) | Python CLI/library or Docker image `datacontract/cli`; **ODCS v3 native** (spec governed by Bitol under LF AI & Data); lint / test / import / export to 25+ formats (SQL DDL, dbt, Avro, JSON Schema, HTML, Protobuf…); test engine is **ibis since 1.0.0, DuckDB for local files**; v1.2.1 (22 Sept 2026) | Testable sources: Snowflake, BigQuery, Databricks, Postgres, MySQL, S3, Kafka, local Parquet/CSV/Delta — **SQLite/D1 not listed**; test D1 data via an exported Parquet/CSV snapshot in R2, or via the contract's schema-only lint (no live data). The contract file itself is the registry: store in git, review in PRs. |
| **Deequ** | Apache 2.0 | Scala/Spark (JVM) | Spark/warehouse only — does not fit. |
| **Apache Griffin** | Apache 2.0 | Spark-based | **Retired to the Apache Attic** — do not adopt. |
| **Pandera** | MIT | Python/pandas dataframe schema validation | Lightweight; usable in CI on exported frames. Niche, not a DQ platform. |
| **Apicurio Registry** (schema registry) | Apache 2.0, CNCF Sandbox (accepted Mar 2026) | Java/Quarkus; stores Avro/Protobuf/JSON Schema/OpenAPI/AsyncAPI artifacts, versioning + compatibility rules; storage Postgres (recommended), Kafka, or in-memory H2; Confluent-compatible API | No Kafka in this stack, so premature as a service — but it is the correct FOSS registry *if* event schemas ever need one. Confluent Schema Registry itself is Confluent Community License (not OSI); Karapace (Apache 2.0) is the Kafka-backed alternative. |

Sources: GX — https://codewithsql.com/sql-tools/great-expectations, https://stackscape.org/en/p/great-expectations/ · Soda — https://codewithsql.com/sql-tools/soda, https://cli.datacontract.com/comparison, https://www.decube.io/post/open-source-data-observability · dbt — https://github.com/codeforkjeff/dbt-sqlite, https://federicocalo.dev/en/blog/05-testing-in-dbt-generic-built-in-tests-custom-sql-tests-and-dbt-expectations · Data Contract CLI — https://cli.datacontract.com/ (`verified live`), https://pypi.org/project/datacontract-cli/1.0.9/ · Apicurio — https://www.apicur.io/registry/, https://www.apicur.io/registry/apicurio-vs-confluent-schema-registry/ · Griffin retirement — https://www.decube.io/post/open-source-data-observability.

**Quality/contracts conclusion:** the stack already has Zod for runtime validation — keep it. The gap is *dataset-level* checks and *versioned contracts*. Fill it with **ODCS contracts in git enforced by the Data Contract CLI in CI** (schema + quality expectations as one file, exportable to DDL/JSON Schema/dbt) plus **GX Core** for richer expectation suites on snapshots. Both are serverless (CLI/library in CI); neither needs a warehouse.

### 4. Data discovery / access / analytical query over object storage (R2)

| Option | License | Shape | Cluster? |
|---|---|---|---|
| **DuckDB** | MIT (IP: DuckDB Foundation) | C++ **embedded/in-process** analytical SQL engine; reads Parquet/CSV/JSON/Iceberg/Delta in place; `httpfs` extension reads S3-compatible storage (R2 is S3-compatible); extensions: `iceberg`, `delta`, `ducklake`, `postgres`; Node/Python/Wasm bindings; **2.0.0 LTS (21 Oct 2026)**. DuckLabs joined AWS (Aug 2026); engine stays MIT under the Foundation. | **No — single library/binary.** Fits as a small dockerized sidecar service (e.g. DuckDB + a thin HTTP wrapper) or DuckDB-Wasm in the browser. Cannot run inside a Cloudflare Workers isolate (native binary; Wasm-in-Workers not verified here). |
| **DuckLake** | MIT | Lakehouse *format*: metadata (schemas, snapshots, stats, file lists) as ordinary tables in a SQL DB (Postgres/MySQL/**SQLite**/DuckDB), data as Parquet in object storage; **1.0 (Apr 2026)** with backward-compat promise; reference implementation is a DuckDB extension; DataFusion/Spark/Trino/pandas clients emerging | No cluster — but the catalog DB is a stateful dependency. Note: DuckLake's catalog DB is reached by the DuckDB extension, so D1-over-HTTP cannot serve as it; use a sidecar SQLite/Postgres for the catalog. The most D1-philosophy-compatible lakehouse: metadata in SQL tables, not manifest files. |
| **Apache Iceberg** | Apache 2.0 | Table *format*, not an engine: needs a catalog (REST — e.g. Apache Polaris, Nessie, Lakekeeper) + an engine (DuckDB/Trino/Spark). DuckDB's `iceberg` extension reads it with partition pruning. | No cluster for reads via DuckDB; a REST catalog is one more small service if writes/multi-engine are needed. |
| **Delta Lake** | Apache 2.0 | Table format; Spark-first historically; DuckDB `delta` extension reads/writes via Delta Kernel (Rust) | No cluster for DuckDB reads; Spark cluster for full write tooling. |
| **Apache Arrow / Parquet** | Apache 2.0 | Columnar format + in-memory toolbox — the *interchange layer*, not a query engine. Parquet on R2 + DuckDB is the concrete combination. | n/a |
| **Trino / Presto** | Apache 2.0 | Distributed MPP: coordinator + worker nodes, federated connectors, JVM | **Yes — a cluster by design.** Does not fit. |
| **ClickHouse** | Apache 2.0 | Single binary, can query S3 directly; very fast OLAP | No cluster required (single node works), but it is a second analytical DBMS to operate, duplicating DuckDB's job — violates "one framework per job" unless DuckDB is rejected for another reason. |
| **Apache DataFusion** | Apache 2.0 | Rust embeddable query engine on Arrow (SQL + DataFrame APIs); Ballista adds distribution | Library/toolkit for *building* engines, not a finished product — only if building a custom engine. |
| **Polars** | MIT | Rust in-process DataFrame library (Python/Rust/Node), lazy queries, Parquet/Arrow I/O | Single-node; distributed execution is commercial Polars Cloud. A library for pipeline code, not a query service. |

Sources: DuckDB — https://stackscape.org/en/p/duckdb/, https://codewithsql.com/sql-tools/duckdb, https://cloudparts.dev/technologies/duckdb/ · DuckLake — https://motherduck.com/learn/ducklake-guide/, https://stackscape.org/en/p/ducklake/, https://cloudparts.dev/technologies/ducklake/ · Iceberg/Delta/Trino — https://fastero.com/blog/trino-vs-duckdb-distributed-vs-embedded-analytics, https://docs.nuedata.eu/docs/adr/ADR-017-table-format-iceberg-vs-hudi/, https://www.awesomeskills.dev/en/skill/data-engineering-skills-lakehouse · DataFusion/Polars — https://github.com/apache/datafusion, https://stackscape.org/en/vs/apache-datafusion-vs-polars/.

**Discovery conclusion:** **DuckDB over Parquet in R2 is the answer** — embedded, MIT, S3-compatible, no cluster, and it doubles as the execution engine for the Data Contract CLI and GX-on-files. Add Iceberg or DuckLake only when multiple engines must share tables or when snapshot/versioning semantics are needed; until then plain Parquet + a naming convention is enough (and is the cheapest option that fits, per the lakehouse guidance found).

### 5. Schema and migration management for SQLite (beyond Drizzle / drizzle-kit)

**No replacement for Drizzle is warranted.** Drizzle Kit (Apache 2.0, TS-native, generates migrations from the TS schema) already fits "one framework per job"; its known gap is no down migrations. Notable alternatives, all of which would *add* a second migration system:

| Tool | License | Notes for SQLite |
|---|---|---|
| **Ariga Atlas** (Community Edition) | **Community Edition: Apache 2.0** (source build); **default binary under Atlas MSA (proprietary)** since v1.3.0 (Aug 2026); Pro from $9/dev/mo | Go CLI; **declarative** (diff desired state → plan, Terraform-style) or versioned; **SQLite in the free/community tier**; has a **Drizzle loader** (reads Drizzle TS models, one of 16 ORM loaders); v1.0.0 Dec 2025, v1.3.0 Aug 2026. Community build lacks views/functions/triggers, linting, drift detection and non-PG/MySQL/SQLite drivers. Only genuine *addition* to Drizzle: declarative diff + drift/lint in CI. Note: it connects to a live database — D1-over-HTTP is not a supported target; use on a local SQLite file in CI. |
| **Flyway** (Redgate) | Apache 2.0 (community engine) | JVM; versioned numbered SQL files; SQLite supported; undo/drift checks paid. Solid but JVM + a parallel migration history vs Drizzle. |
| **Liquibase** | **FSL-1.1-ALv2 since Community 5.0 (late 2025) — not OSI** (was Apache 2.0; releases revert to Apache 2.0 two years after shipping) | Java 17+; XML/YAML/JSON/SQL changelogs; SQLite supported; rollback in free edition. Excluded on license grounds for a strict FOSS policy. |
| **DBmate** | MIT | Single Go binary, plain timestamped SQL, Postgres/MySQL/**SQLite**/ClickHouse, Docker-friendly. The simplest *alternative* runner — but still a second system. |
| **golang-migrate / goose** | MIT / MIT | Go; versioned up/down SQL; SQLite supported; goose also supports Go-function migrations (data backfills). Same verdict as DBmate. |

Sources: Atlas — https://github.com/ariga/atlas, https://cloudparts.dev/technologies/atlas/, https://codewithsql.com/sql-tools/ariga-atlas · others — https://www.bytebase.com/blog/top-open-source-mysql-migration-tools/, https://encore.dev/articles/database-migration-tools, https://www.bytebase.com/blog/top-database-schema-change-tool-evolution/.

**Verdict:** keep Drizzle Kit as the migration system. Optionally add **Atlas Community in CI** (declarative diff of the Drizzle schema against a scratch SQLite file, to catch drift and destructive changes) — it is the only tool here that *complements* rather than duplicates Drizzle.

### 6. Fit verdicts (all candidates)

| Candidate | Verdict | Why |
|---|---|---|
| DuckDB | **Fits as-is (library) / dockerized sidecar** | MIT, embedded, no server; httpfs → R2 (S3-compatible); Parquet/Iceberg/Delta/DuckLake. Not inside Workers; sidecar or Wasm-in-browser. |
| Data Contract CLI (ODCS) | **Fits as-is (CLI in CI)** | MIT, no server, Docker image; contracts in git. Live-test needs a supported source — use R2 snapshots for D1 data. |
| OpenLineage client-only (JSON events → D1) | **Fits as-is** | Apache 2.0 spec; no server, no SDK needed from TS; File/Console transports. |
| sqllineage / SQLGlot | **Fits as-is (CI library)** | MIT, no server; static SQL parsing. Single-maintainer caveat for sqllineage. |
| GX Core | **Fits dockerized / CI sidecar** | Apache 2.0, Python; SQLite supported — on exported snapshots only (no D1 wire protocol). |
| Datasette | **Fits dockerized as sidecar** | Apache 2.0, single container; serves SQLite *files* — needs D1 export snapshots. Best DataStudio replacement. |
| Marquez | **Fits dockerized as sidecar** | Apache 2.0; Java + Postgres only (2–3 containers); no auth by default — put behind auth. Release cadence watch (no release since Oct 2024, per secondary source). |
| ODD Platform | **Fits dockerized as sidecar** | Apache 2.0; Java + Postgres only — lightest full catalog; still a second metadata DB + JVM to operate. Defer until D1-table catalog is outgrown. |
| Apicurio Registry | **Fits dockerized as sidecar — premature** | Apache 2.0; Java/Quarkus + Postgres; correct registry if/when event schemas need governing; no Kafka in stack today. |
| Ariga Atlas (Community) | **Fits as-is (CI tool)** | Apache 2.0 community build; SQLite + Drizzle loader; complement to Drizzle Kit, not a replacement. Default binary is proprietary — use the community build. |
| DBmate / golang-migrate / goose | **Fits, but redundant** | MIT, tiny; would duplicate Drizzle Kit — only if Drizzle were dropped. |
| Iceberg / Delta Lake (via DuckDB) | **Fits as format, via DuckDB** | Apache 2.0; no cluster when read through DuckDB. Adopt only when multi-engine sharing or time travel is needed. |
| DuckLake | **Fits as sidecar pattern — watch maturity** | MIT; metadata in a SQL DB + Parquet in R2; 1.0 Apr 2026; ecosystem younger than Iceberg's. |
| DataHub | **Does not fit** | Kafka + ES/OpenSearch + MySQL/Postgres + GMS + frontend; no SQLite/D1; needs a platform team. Revisit only at much larger scale. |
| OpenMetadata | **Does not fit (now)** | No Kafka, but still Java server + MySQL/Postgres + ES/OpenSearch cluster + Airflow; no SQLite/D1; plus the Collate Community License wrinkle on ingestion/UI. Lightest of the big three — the fallback if ODD proves too small. |
| Apache Atlas | **Does not fit** | HBase/JanusGraph + Solr + Kafka + ZooKeeper; Hadoop-centric. |
| Amundsen | **Does not fit — archived Sept 2026** | No maintenance, no security fixes. |
| Unity Catalog OSS | **Does not fit** | Lakehouse/Delta-Iceberg catalog; Java + Postgres; OSS lacks lineage/DQ; APIs evolving. |
| CKAN / Magda / Egeria | **Does not fit** | Publishing/federated/governance products (Postgres + Solr/ES + Redis/Kafka, K8s microservices), not OLTP table catalogs. |
| Trino / Presto | **Does not fit** | JVM coordinator+worker cluster by design. |
| Soda Core | **Does not fit a strict FOSS policy** | ELv2 since Jan 2026 (source-available, not OSI). Technically capable; license-excluded. |
| Liquibase | **Does not fit a strict FOSS policy** | FSL-1.1-ALv2 since 5.0 (late 2025, not OSI). |
| Deequ / Griffin | **Does not fit** | Spark-only; Griffin retired to the Attic. |
| ClickHouse / DataFusion / Polars | **Conditional / not a product** | ClickHouse duplicates DuckDB's job; DataFusion is a toolkit, Polars a DataFrame library — building blocks, not catalog/quality solutions. |

### 7. Ranked shortlist (cataloguing + lineage + quality, best fits overall)

| Rank | Option | What custom code it replaces (one line) | Shape |
|---|---|---|---|
| 1 | **DuckDB** (MIT) + Parquet on R2 | Replaces the planned DataStudio's analytical half and any hand-rolled file-scanning/discovery code: one embedded engine queries R2 Parquet (and later Iceberg/DuckLake) with SQL, as a small sidecar or DuckDB-Wasm in the browser. | Library / sidecar |
| 2 | **Data Contract CLI — ODCS** (MIT) | Replaces hand-written data validators and the in-code product registry as the source of truth: one versioned `.odcs.yaml` per dataset, linted and tested in CI, exporting DDL/JSON Schema/dbt models. | CLI in CI |
| 3 | **OpenLineage client-only events → D1** (Apache 2.0), Marquez optional later | Replaces "no lineage tracking" with zero new infrastructure: Workers emit standard JSON lineage events into D1 tables; the React app renders the graph; Marquez can be added later as the viewer without changing producers. | Library (TS, no SDK needed) |
| 4 | **GX Core** (Apache 2.0) | Replaces hand-written dataset validators with declarative Expectation suites run in CI/sidecar against D1 export snapshots, with HTML Data Docs as output. | Python in CI / sidecar |
| 5 | **ODD Platform** (Apache 2.0) — deferred | Replaces the hand-rolled DDL/DML catalogues wholesale *when* they outgrow D1 tables: the only full catalog needing just Postgres + one container, with lineage and GX/dbt quality hooks built in. Adopt last, not first. | Dockerized sidecar |

Honourable mention: **Datasette** (Apache 2.0) — the most direct replacement for the planned read-only DataStudio viewer if a D1 → SQLite snapshot export exists (one container, browsable tables + JSON API + full-text search, zero modelling). **Atlas Community** (Apache 2.0) in CI is the only schema-tool addition worth considering alongside Drizzle Kit.

**Recommended sequencing:** (a) formalise the catalogue as Drizzle tables in D1 + Zod (keep the pin tests — they become contract tests); (b) adopt ODCS contracts + Data Contract CLI in CI; (c) emit OpenLineage events from Workers into D1; (d) stand up a DuckDB sidecar over R2 Parquet exports for discovery/analytics (Datasette alongside it for the read-only viewer); (e) add GX Core suites on the same snapshots; (f) only if the D1 catalog proves insufficient, evaluate ODD Platform as a sidecar — and skip DataHub/OpenMetadata/Atlas/Amundsen entirely at this scale.

## Could not verify / open questions

- **No official OpenLineage TypeScript/JavaScript client was found** in this research; the recommendation to emit raw JSON from TS rests on the spec being JSON Schema — confirm against the OpenLineage spec (https://openlineage.io) before building the emitter.
- **DuckDB-Wasm inside Cloudflare Workers** was not verified; DuckDB-Wasm is documented for browsers, and Workers isolates cannot run the native binary. The sidecar deployment is the safe claim; in-browser Wasm for DataStudio is plausible but unconfirmed here.
- **Whether D1 can be exported to a SQLite file / Parquet in R2** on a schedule (the snapshot step every sidecar tool depends on) — assumed feasible via the app's own export; not verified against Cloudflare docs in this research.
- **OpenMetadata's Collate Community License 1.0** scope (which folders/features it covers) is reported by a secondary source (Atlan, Nov 2026); confirm in the repo before any adoption.
- **CKAN's license** was not verified in this research and is not stated above; irrelevant to the recommendation (CKAN does not fit regardless).
- **Marquez release cadence**: the project README still marks it "under active development" (`verified live`), while a secondary index claims no release since Oct 2024 — the discrepancy is unresolved; check the releases page before adopting Marquez.
- **Soda Core / Liquibase license changes** are reported by multiple secondary sources agreeing (Jan 2026 ELv2; late-2025 FSL) but were not re-verified against the repos' LICENSE files in this session.
- No live deployment was tested; all fit verdicts are from documentation/architecture, not from running the tools against D1.

## Sources

Per-source notes with URLs and read dates: `notes/catalog.md`, `notes/lineage-quality.md`, `notes/query-schema.md` (all read 2026-11-24; `verified live` only for https://github.com/MarquezProject/marquez and https://cli.datacontract.com/).

Key primary sources: Marquez README — https://github.com/MarquezProject/marquez · Data Contract CLI — https://cli.datacontract.com/ · Apicurio Registry — https://www.apicur.io/registry/ · Ariga Atlas — https://github.com/ariga/atlas · Apache DataFusion — https://github.com/apache/datafusion · dbt-sqlite — https://github.com/codeforkjeff/dbt-sqlite · OpenLineage Python client config — https://github.com/openlineage/openlineage-site/blob/HEAD/versioned_docs/version-1.42.1/client/python/configuration.md
