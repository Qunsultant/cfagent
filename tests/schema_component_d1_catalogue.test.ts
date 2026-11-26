/**
 * #4282 P1 — D1 catalogue: migrationRunner delegates to the catalogue.
 *
 * The catalogue is the D1 plane's single home for statement text; the
 * runner assembles each migration's sql from its catalogue codes and
 * remains the single D1 executor (delegation, not absorption).
 *
 * Anchors (measured from the base runner at 534e8903, before the
 * delegation — never re-derived from the delegated runner):
 *  - D1_MIGRATION_SQL_SHA256: sha256 of each migration's sql string.
 *    A change to any migration's text — a column, a DEFAULT, a seed
 *    value, even whitespace — fails this pin. Migrations are immutable;
 *    a new migration adds one hash line here.
 *  - D1_MIGRATION_STATEMENT_COUNTS: per-version statement counts.
 *  - D1_SEED_STATEMENTS: the 12 seed-DML statements, exact text.
 *    Seeds do not change the schema model, so the equality pin cannot
 *    see them — this list is their anchor.
 *  - The expected-model fixture
 *    (tests/schema_component_d1_expected_model.json): the D1 schema
 *    model built by executing the base runner's migrations, in version
 *    order, through the P0 InMemorySchemaInstance — 100 tables, 59
 *    indexes (97 + 3 bundle tables, 56 + 3 bundle indexes, #2781). Regenerate only with SCHEMA_D1_FIXTURE_WRITE=1 from a
 *    clean checkout, and review the refreshed fixture in the PR diff:
 *    a refresh that changes an existing table without a migration is
 *    a defect, not a cleanup (same discipline as the grep baseline).
 *
 * Scope correction (measured on the tip, not the filing counts): the
 * runner carries 216 statements, not the filed ~148 + 5. The filing
 * counts counted only CREATE TABLE / CREATE INDEX / CREATE UNIQUE
 * INDEX lines; the runner also carries 50 ALTER TABLE statements, 1
 * DROP TABLE, and 10 seed-DML lines (the survey's 5 named seeds plus
 * 5 more in the v58 product-versions data migration, plus 10 more in
 * the v66 referral-codes migration that landed on main (534e8903) after
 * the P1 build base. All 216 are
 * catalogued here — a partial catalogue could not satisfy the
 * byte-identical acceptance pin. The `_migrations` bookkeeping table
 * (created by applyMigrations, not by a migration) is runner
 * infrastructure and is NOT catalogued.
 *
 * P6e decision (recorded here, per the P1 body): the inline seed
 * copies do NOT remain in the runner. Every seed line's text lives
 * only in its catalogue entry; the runner assembles it from the code.
 * Keeping copies would reintroduce the two-source drift this
 * programme exists to remove. P6e therefore has nothing left to
 * remove.
 */
import { describe, expect, it } from "vitest";
import { createHash } from "node:crypto";
import { readFileSync, writeFileSync } from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { ALL_MIGRATIONS } from "../src/data/migrationRunner";
import {
  buildD1Catalogue,
  D1_CATALOGUE_ENTRIES,
  D1_MIGRATION_CODES,
  d1MigrationSql,
} from "../src/data/schemaComponent/d1Catalogue";
import { validateCatalogueEntry } from "../src/data/schemaComponent/catalogue";
import {
  InMemorySchemaInstance,
  runEqualityCheck,
  splitStatements,
  type SchemaModel,
} from "../src/data/schemaComponent/equalityHarness";

/** sha256 of each migration's sql string, measured from the base runner. */
const D1_MIGRATION_SQL_SHA256: Record<number, string> = {
  1: "ae376c28259a92df70e537e7740e1ddca1ee76ac9b979ddf4d70652c91c8ca8c",
  2: "994d90a739829055d5d039de3f9480d32c9a3779686a7efde2feee1332e98cfa",
  3: "eb7e10ced4d86fa10b0a8052b87aef76249ec880fc93cb6259ff48cdb061291e",
  4: "5cbfc445b9cb45927bb8a350f620d8b089cde396612df34e143081cba6f79274",
  5: "ac088ec90e08ac23cc41c0eedd2a8f91420b145ff2c4bfbc5f07f425a9086ecd",
  6: "740c0ef426b571e1f6fd73e71fe95aff5079626767167f9d89af8cc52b378719",
  7: "6923ff0b8d27de3b7836d7e26cd39b7cb0b40bd3e955c96ca7977a8b326b7b0a",
  8: "3dc3f3b8a607e351d697bb493f162dcb2fafb1c64b62e3adb690c937e74e5ef5",
  9: "d783d5d6aff34d5baffe8ce5262fe42e570ddcc703faec545c30fcd37578cc5e",
  10: "f5f69ef03f27b9d2c6f4fa8dd73895f19445c8be0687e3a9b5fbd5ae20dba274",
  11: "45a85bf1dc23565caad94dd9025326933b01d5c9b8cad705475a310d5d3e8817",
  12: "672caf1eaa5800db3e5bf91445b92cc390e7680a2e6ff82197014497b31b50f5",
  13: "3e59463fa840c6c359f956f9ad0464affcafd02452784580e0cc079033881410",
  14: "366d2df956ab110f202ee80b85d36403db9d0d71fbdf7b3548f08e3ecf274d9a",
  15: "287fcdbc558218179ad5dbe3dddf0f83dfe962c333be99e2991cc1a483c88bd5",
  16: "572fe3d3831d1394341b3b202280984bb954655e4d2b4fe7c3a2071392b85be9",
  17: "e1753259daaa511f049746eed52cfd4458623acdfd282d11167ca18b34ed7f61",
  18: "ea4a8b73c64eba7203cc34006fd5cb9abd4549909e8e9bc0ddd5c25182ec3871",
  19: "b94460a04da258a132decd9574e9f3ee8870279306c3badf21c1854fe4761ca1",
  20: "811e6adfb5ae4a9a144fc91a5f388b6517e12877ed86b4a61f34059a325fed44",
  21: "93236d290ad8762451eb73c971d1dfb5a36480cd85b15bcf147cd5577e86d024",
  22: "dbc3e57c67a151d8d95abe94d07e79d4a4680c288b235dfa05f27d014992fa3f",
  23: "65f708dac62bf737bbbcbf0c53efe727fd14cecd5e3898413dacca6c98f0873f",
  24: "460860c9f73421778ca13cc08b7137622a084043bdf0e0a739874d5082943876",
  25: "ddfda6a0ff3316c7d5d49b5dd8c422b9a938088fdeb58a952120253c8b4063c4",
  26: "ca23f34030fa697852a8b08f63c4988438c4fabf81dd4e0d23dda80dd12e336c",
  27: "64a87db7a7d511cf273abe7c53e77d8b076ee5d83f19f2858410600b6dbc2c91",
  28: "5df6caff08f2e3efa698f642d437f08b397bb8fd79b642cb63b04e0ad148077c",
  29: "983065019531853c1c3aeca0a260f75a63e8da79773771158ae5d272581512e9",
  30: "330d66035cf765eeee86b3d2e6e0258a9a30202ddbb96cdaeea629181ea6e4bd",
  31: "f98f0297c59ff30f5df2701a47daa5c674cce795100373b5ae750841656ea27b",
  32: "6962b249af992a5b8de91ea5dcced42d960a37cda448ff3996c0dedd66dd6843",
  33: "898dca3c36e21edc376d880ca7174e6b4e693fb60c3ecf9019c95f177839d732",
  34: "baacfe44e70d0f97093ae2128b52907fe4d459feaeb74e2a6fbdb5a20136a461",
  35: "cab5e376330728b1288048393adf5129063d32e91ec5203f5e6dc5340e4adb62",
  36: "6631d20d076bf0838b78520252f5124cbee52dffaac373094d7c1e43950a74e2",
  37: "d01c7c0d3e8986029e6d6f6b6afdda9f162128499dbe223d861dee5dbbe9bfdd",
  38: "e7bb35c4541426498b519b5bc2e669cdf7191d0267e457674d0953c66584a6fe",
  39: "061114261eb3ebf4cf5e9c3ecaaae25d8bdda372058daf2c9ba07f91ccbb2363",
  40: "9b42c8b8ec141d7a3e5962c1869149b201b8d50e2066495b88fd1c89797e3ed4",
  41: "30da753f26e70a7bb5ec6afb2b54674cae9cb31d3abe484aff88e7acb0b8f60f",
  42: "829c5c5c8cf56df58ebdce6db92ff0267971ec1f9697e08bdee8d9f71674c5f2",
  43: "f035b4d46a7564db018f0f7b3fafd63ab7779081d1be2ab121f9fbc72b30d22b",
  44: "66fbd25ab92facaf05828991c09b87b63d5cfcbc43c6f6c0194c26d8dbeb96bf",
  45: "2a01fcb6b2267b00d9dc18325dc68347108dcb7d5e2459b32cbca56caa26c7b7",
  46: "fee2e6af36cd772279ef5364030f2ec157b0542888fcff74c31fe8d37af2653e",
  47: "291667431032fce27f592e4c85dbecd1b38e5b4c53cc228488258651d1670239",
  48: "9f7471a567f303160fd3897ad7a88b5f0b275985de558171acefec1d4eebaa65",
  49: "7f21ef683cbe299acc4a11d4c8bbfd7b6c17ea74b1373feb1c76b6ae93240b19",
  50: "817a136395d978329c4e06bbdab27a761791594383416dff75179478907996dd",
  51: "55151bada94f5fdcd779cc73cc6654377f6d8611b7a0d90a268543cdb716304d",
  52: "1943156da346419067a10fff385873edcf897eaa660891e3a40edff22bf40c74",
  53: "acd98b0192c74ed3e3d43f0016f4cfa2cc36c0be7dc2cdd4b3cf9275c4be02f6",
  54: "b50bc0689780be4ad5e0896d0706dc0a550b46175d457329ab16a0335000aeec",
  55: "3db54166e6cfc67a2f8b3115310e1e7f8437ff391622be013d11cc1493d21970",
  56: "443b0eaf492fc13fdfaacf303218cd137fc2f6e6f5bf3bbd245a1096994a07b7",
  57: "af246269a138ece7bbae4aaed3297971b865ed6c39f4d4154c47c4c690136392",
  58: "60493ac87d07df6aa99d2cdad3a887782b59b8f1aa162cb1059b43191e324534",
  59: "483a9808b7c8241c21e3cec650d0427bf8387e857798ca7ddc07611a9ebdb7b9",
  60: "e348f1d119a1b9ce360b20503c108f92803667a3d551dcecc63afef51f5e8124",
  61: "eff48788a99a65b357988427be9eb5d08753e9b20596456774d1d2a1fc8c51f4",
  62: "b21d1c020ccfd18fbad2476742bcff83d3fe8ea99039b78d953caea8de3217f3",
  63: "1ab5442d85c61ee93824d27f2b5b7cb58e5a5aba536cd559fe3582d7887d4a6c",
  64: "05351b7cc2e974a65e566e225a87d84a34318c1ac6c66311acb12d381c790121",
  65: "8ae8db73d068294023dddf8f77bba1f330a034a08ea31d70e53a8871e4a61fa3",
  66: "bc6889fe632afcd5f76a8998668a4d0a09aedb690aac5a876a367751d5b6b2d4",
  67: "651071233310241645a5a826fcca8c0b3de60c47eedbfa0ec5625428e54a3913",
  68: "7ea09289f5ad6227af9f658167ac90124a0d901b7537c68f3680904d1c605de3",
  69: "ddad4a10dbb801c08c67b5c4b3e587e689f7be39e3b51fc8287a126a7337c877",
  70: "df8d7fb4f485096b4f911e91d7b88d9ae820d31a75a9a48b164d9232dc74f22b",
  71: "c19368069237661aadf7af1f6a8eb015f12b705deed9f59af621482d896ea4bf",
  72: "9786cf1c24503046615b3bba4270cd79732e70d8127d8c17c03e7c190b0987f7",
  73: "6048450ab44e1b4f8e39ee9b428a42f23ff7f2a7385d350f52544fba8793a634",
  76: "e623ed7d7491e9edec5b3a06e4555d10b3a43829294fecf5ae5200c76021e7be",
  75: "e1e8450e299a7dab5e6f2a768e5db249020f2c22997dc40536da975518259836",
  74: "7b53a58d4917e8118af27ed53ff5611a9b6846b69499959de5c61b5fa9c51c18",
  77: "9ab9c8a81b2937bdc4ed9caf68f70951803baed677a1c35f4a29fa7da5c50096",
  78: "b21108871d584314ec5b14ddfdcb0381e80085583ffefa24364590f39c7defd5",
  79: "058ac5fa01d81432149e2c7a084b68cf4a42d2411baf141c624a899bb1ddc8d5",
  // #6072 adds migration 0080 (agent_screener_task_entries table).
  80: "6761e28c163ce021d52e5cee3dd57eb3989504d10ad585443386956657bd917e",
  // #6099 adds migration 0081 (job_run_records tenant_id +
  // projected_at_ms + unique identity index).
  81: "f5b6659bebc315b6f5ad499fa459c2f3b1f8b9196f28807fc2dcc614507ccd90",
  82: "6dbf344114cffc578c59fae8eb4b17abba4a459c6748fa603c0e6a9428ac37dd",
  // #6028/#6202 adds migration 0083 (the D1 stage-row mirror).
  83: "22376bf449c011f4a8a085ff2e0ab83da52e3c59fc03d8096fba047bc434e598",
  // #5102 adds migration 0084 (job_run_records binding tuple: 4
  // ALTERs + the binding-read index): 5 statements.
  84: "74b9fd18e06cb9b7abea9eceb2f53d69fb2fdc2d7f35ec42300fda893376b3a8",
  // #6151 S3 adds migration 0085 (saved nav presets: agent_nav_presets
  // + agent_nav_preset_state): 4 statements.
  85: "acbca0e1d709401ae86c4ca1b2388960761e8d311ea472987942959b9ad5f860",
  // #6006 adds migration 0086 (job_run_records outcome facts: 9
  // ALTERs). Renumbered 0083 -> 0086 on rebase (main took 0083-0085).
  86: "5ccea3ee0f4183d634f94f507f4914031e73c5e38a1cca6b60e2ef4e6f64ceb7",
  // #6151 S4 adds migration 0087 (nav admin config: allowances +
  // allow-lists + persona defaults): 4 statements. Renumbered
  // 0086 -> 0087 on rebase (main took 0086 for #6006).
  87: "881fa0f8c589e31f2a608b405481dba350778a6649596a6e7b5c1eb074b4e2d4",
  // #5160 adds migration 0088 (IDP attributes profile: rebuild
  // agent_user_profiles with the (internal_user_id, tenant_id) key
  // + the agent_identity_attribute_index table): 6 statements.
  // Renumbered 0086 -> 0087 on rebase (main took 0086 for #6006's
  // outcome facts), then 0087 -> 0088 on rebase (main took 0087
  // for #6151's nav admin config).
  88: "f037e33cafe2251ce50921754dedd1ee34ffff7d1404586bd135dfbf93351ff1",
  // #6102 adds migration 0089 (mas_events moves from the DO to D1
  // by replacement: the D1 table + its six indexes): 7 statements.
  89: "c71e3f5330d8bed684bfe29b8afb214320a4d57631874b2c000c9b311225b111",
  // Issue #6557 — the instance provenance carrier (one ALTER).
  90: "e01a768735f78765dca5c8175b0a4fa47445da5d44698fcdc51dcf0cc02fc9fc",
  // Issue #6557 — the four #3655 provenance columns on the run record.
  91: "512b256bba92bf3f267fb058cfa9245485b3c2bf4333ee2c36fb311a5a49f3f3",
  // #6503 adds migration 0092 (D1 unified_schedules table + 3
  // indexes + the built-in-goals seed): 5 statements. The five
  // system-schedule seeds are Recreate steps, not migration-applied
  // (#6503 step 7: a fresh store starts empty).
  92: "c79093d94c6ee5eec808cb3f449619ba1de498d2ebf77d53a00c98a84a60a421",
  // #6101 adds migration 0093 (run-record identity columns +
  // carrier-table drop): 6 statements.
  93: "883dd6c711bbb3dd9bd5cad36cb5d0a900a9308d88f1198c8df7a3400f2a7621",
};

/** Per-version statement counts, measured from the base runner. */
const D1_MIGRATION_STATEMENT_COUNTS: Record<number, number> = {
  1: 2,
  2: 4,
  3: 1,
  4: 5,
  5: 4,
  6: 5,
  7: 5,
  8: 5,
  9: 4,
  10: 1,
  11: 1,
  12: 4,
  13: 2,
  14: 4,
  15: 7,
  16: 5,
  17: 11,
  18: 2,
  19: 6,
  20: 2,
  21: 4,
  22: 5,
  23: 2,
  24: 2,
  25: 3,
  26: 2,
  27: 3,
  28: 2,
  29: 1,
  30: 1,
  31: 2,
  32: 1,
  33: 2,
  34: 2,
  35: 2,
  36: 3,
  37: 2,
  38: 1,
  39: 1,
  40: 3,
  41: 1,
  42: 1,
  43: 2,
  44: 1,
  45: 1,
  46: 4,
  47: 2,
  48: 2,
  49: 4,
  50: 2,
  51: 2,
  52: 2,
  53: 6,
  54: 3,
  55: 2,
  56: 2,
  57: 2,
  58: 31,
  59: 4,
  60: 3,
  61: 1,
  62: 3,
  63: 3,
  64: 2,
  65: 1,
  66: 10,
  67: 1,
  68: 1,
  69: 1,
  70: 1,
  71: 2,
  72: 2,
  73: 1,
  76: 1,
  75: 1,
  74: 2,
  77: 3,
  78: 1,
  79: 2,
  // #6072 adds migration 0080 (agent_screener_task_entries table): 1 statement.
  80: 1,
  // #6099 adds migration 0081 (job_run_records projection): 3 statements.
  81: 3,
  82: 9,
  83: 2,
  // #5102 adds migration 0084 (job_run_records binding tuple: 4
  // ALTERs + the binding-read index): 5 statements.
  84: 5,
  // #6151 S3 adds migration 0085 (saved nav presets: 2 tables + 2 indexes): 4 statements.
  85: 4,
  // #6006 adds migration 0086 (job_run_records outcome facts: 9 ALTERs).
  86: 9,
  // #6151 S4 adds migration 0087 (nav admin config: 3 tables + 1 index): 4 statements.
  87: 4,
  // #5160 adds migration 0088 (IDP attributes profile: rebuild
  // agent_user_profiles + the lookup-index table): 6 statements
  // (rename, create table, insert-from-legacy, drop legacy, unique
  // index, index table).
  88: 6,
  // #6102 adds migration 0089 (mas_events D1 table + six indexes):
  // 7 statements.
  89: 7,
  // Issue #6557 — one instance ALTER, four record ALTERs.
  90: 1,
  91: 4,
  // #6503 adds migration 0092 (D1 unified_schedules table + 3
  // indexes + the built-in-goals seed): 5 statements. The five
  // system-schedule seeds are Recreate steps, not migration-applied
  // (#6503 step 7: a fresh store starts empty).
  92: 5,
  // #6101 adds migration 0093 (run-record identity columns +
  // carrier-table drop): 6 statements.
  93: 6,
};

/** The 19 seed-DML statements, exact text, measured from the base runner. */
const D1_SEED_STATEMENTS: string[] = [
  "INSERT OR IGNORE INTO agent_referral_rules (id, earn_amount_usd, vesting_delay_ms, redemption_scope, updated_at_ms) VALUES ('default', 0.5, 604800000, 'pay-per-run', 0)",
  "INSERT OR IGNORE INTO agent_free_run_allowances (family, runs, updated_at_ms) VALUES\n  ('stock', 10, 0),\n  ('goal', 10, 0),\n  ('options', 10, 0),\n  ('strategy', 10, 0)",
  "UPDATE agent_subscription_plans SET approval_status = 'approved' WHERE approval_status = 'proposed'",
  "INSERT OR IGNORE INTO agent_approved_free_quotas (family, cap_runs, updated_at_ms, updated_by) VALUES\n  ('stock', 10, 0, NULL),\n  ('goal', 10, 0, NULL),\n  ('options', 10, 0, NULL),\n  ('strategy', 10, 0, NULL)",
  "INSERT OR IGNORE INTO agent_approved_free_quota_settings (id, window_kind, at_limit_action, updated_at_ms, updated_by) VALUES\n  ('default', 'month', 'upgrade_or_buy_credits', 0, NULL)",
  "INSERT OR IGNORE INTO agent_products (id, name, kind, description, created_at_ms, updated_at_ms)\n  VALUES\n    ('prod-per-run-stock', 'stock', 'per_run', NULL, 0, 0),\n    ('prod-per-run-goal', 'goal', 'per_run', NULL, 0, 0),\n    ('prod-per-run-options', 'options', 'per_run', NULL, 0, 0),\n    ('prod-per-run-strategy', 'strategy', 'per_run', NULL, 0, 0),\n    ('prod-free', 'Free', 'subscription', NULL, 0, 0)",
  "INSERT OR IGNORE INTO agent_products (id, name, kind, description, created_at_ms, updated_at_ms)\n  SELECT 'prod-sub-' || lower(replace(trim(name), ' ', '-')), MIN(name), 'subscription', NULL, MIN(created_at_ms), MIN(created_at_ms)\n  FROM agent_subscription_plans\n  GROUP BY 'prod-sub-' || lower(replace(trim(name), ' ', '-'))",
  "UPDATE agent_subscription_plans SET\n  product_id = 'prod-sub-' || lower(replace(trim(name), ' ', '-')),\n  segment = 'default',\n  version = (\n    SELECT COUNT(*) FROM agent_subscription_plans AS p2\n    WHERE 'prod-sub-' || lower(replace(trim(p2.name), ' ', '-')) = 'prod-sub-' || lower(replace(trim(agent_subscription_plans.name), ' ', '-'))\n      AND (p2.created_at_ms < agent_subscription_plans.created_at_ms OR (p2.created_at_ms = agent_subscription_plans.created_at_ms AND p2.id <= agent_subscription_plans.id))\n  ),\n  effective_from_ms = created_at_ms + (\n    SELECT COUNT(*) FROM agent_subscription_plans AS p2\n    WHERE 'prod-sub-' || lower(replace(trim(p2.name), ' ', '-')) = 'prod-sub-' || lower(replace(trim(agent_subscription_plans.name), ' ', '-'))\n      AND (p2.created_at_ms < agent_subscription_plans.created_at_ms OR (p2.created_at_ms = agent_subscription_plans.created_at_ms AND p2.id < agent_subscription_plans.id))\n  ),\n  effective_to_ms = NULL,\n  billing_period = CASE WHEN period_days = 365 THEN 'annual' ELSE 'monthly' END,\n  features_json = NULL,\n  stripe_price_id = NULL",
  "INSERT INTO agent_price_catalogue (id, family, price_usd, updated_at_ms, approval_status, approved_by, approved_at_ms, product_id, segment, version, effective_from_ms, effective_to_ms)\n  SELECT 'cat-' || family || '-default-v1', family, price_usd, updated_at_ms, approval_status, approved_by, approved_at_ms, 'prod-per-run-' || family, 'default', 1, updated_at_ms, NULL\n  FROM agent_price_catalogue_legacy",
  "UPDATE agent_products SET rank = 1 WHERE id = 'prod-free'",
  "INSERT OR IGNORE INTO agent_referral_code_rules (id, product_id, issuer, runs_per_code, reusable, expiry_days, attribution_mode, max_redemptions_per_code, max_redemptions_per_login, global_cap, redemption_count, active, created_at_ms, updated_at_ms)\n  VALUES\n    ('coderule-seed-prod-per-run-stock', 'prod-per-run-stock', 'platform_admin', 5, 0, 30, 'ledger', 1, 1, NULL, 0, 0, 0, 0),\n    ('coderule-seed-prod-per-run-goal', 'prod-per-run-goal', 'platform_admin', 5, 0, 30, 'ledger', 1, 1, NULL, 0, 0, 0, 0),\n    ('coderule-seed-prod-per-run-options', 'prod-per-run-options', 'platform_admin', 5, 0, 30, 'ledger', 1, 1, NULL, 0, 0, 0, 0),\n    ('coderule-seed-prod-per-run-strategy', 'prod-per-run-strategy', 'platform_admin', 5, 0, 30, 'ledger', 1, 1, NULL, 0, 0, 0, 0)",
  "INSERT OR IGNORE INTO job_pipeline_definition_versions (id, job_id, version, definition_json, updated_at) SELECT job_id || ':' || version, job_id, version, definition_json, updated_at FROM job_pipeline_definitions",
  // #5160 adds migration 0087 (IDP attributes profile: the legacy
  // backfill INSERT — the rebuild's INSERT ... SELECT).
  "INSERT INTO agent_user_profiles (user_login, display_name, phone, email, updated_at_ms, internal_user_id, tenant_id, idp_issuer, idp_attributes_json, provenance_json, idp_updated_at_ms)\n  SELECT user_login, display_name, phone, email, updated_at_ms, NULL, NULL, NULL, NULL, NULL, NULL\n  FROM agent_user_profiles_legacy",
  // #6503 adds migration 0092 (D1 unified_schedules seeds: five
  // system schedules + the nine built-in goals).
  `INSERT OR IGNORE INTO unified_schedules (id, kind, state, callback, operation, definition_json, owner_login, provenance_json, alarm_id, paused_at, created_at, updated_at) VALUES ('token-renewal', 'internal', 'paused', 'autoRenewETradeTokens', NULL, '{"type":"interval","intervalSeconds":2592000,"callback":"autoRenewETradeTokens"}', NULL, '{"origin":"system","createdBy":"system","reason":"token-renewal","createdAt":"2026-11-25T00:00:00.000Z"}', NULL, '2026-11-25T00:00:00.000Z', '2026-11-25T00:00:00.000Z', '2026-11-25T00:00:00.000Z')`,
  `INSERT OR IGNORE INTO unified_schedules (id, kind, state, callback, operation, definition_json, owner_login, provenance_json, alarm_id, paused_at, created_at, updated_at) VALUES ('retention', 'internal', 'paused', 'retention', NULL, '{"type":"interval","intervalSeconds":2592000,"callback":"retention"}', NULL, '{"origin":"system","createdBy":"system","reason":"retention","createdAt":"2026-11-25T00:00:00.000Z"}', NULL, '2026-11-25T00:00:00.000Z', '2026-11-25T00:00:00.000Z', '2026-11-25T00:00:00.000Z')`,
  `INSERT OR IGNORE INTO unified_schedules (id, kind, state, callback, operation, definition_json, owner_login, provenance_json, alarm_id, paused_at, created_at, updated_at) VALUES ('nightly-research', 'internal', 'paused', 'runResearchSchedule', NULL, '{"type":"interval","intervalSeconds":2592000,"callback":"runResearchSchedule"}', NULL, '{"origin":"system","createdBy":"system","reason":"nightly-research","createdAt":"2026-11-25T00:00:00.000Z"}', NULL, '2026-11-25T00:00:00.000Z', '2026-11-25T00:00:00.000Z', '2026-11-25T00:00:00.000Z')`,
  `INSERT OR IGNORE INTO unified_schedules (id, kind, state, callback, operation, definition_json, owner_login, provenance_json, alarm_id, paused_at, created_at, updated_at) VALUES ('sweep-stale-async-jobs', 'internal', 'paused', 'sweepStaleAsyncJobs', NULL, '{"type":"interval","intervalSeconds":2592000,"callback":"sweepStaleAsyncJobs"}', NULL, '{"origin":"system","createdBy":"system","reason":"sweep-stale-async-jobs","createdAt":"2026-11-25T00:00:00.000Z"}', NULL, '2026-11-25T00:00:00.000Z', '2026-11-25T00:00:00.000Z', '2026-11-25T00:00:00.000Z')`,
  `INSERT OR IGNORE INTO unified_schedules (id, kind, state, callback, operation, definition_json, owner_login, provenance_json, alarm_id, paused_at, created_at, updated_at) VALUES ('schedule-watchdog', 'internal', 'paused', 'watchdogMissedSchedules', NULL, '{"type":"interval","intervalSeconds":2592000,"callback":"watchdogMissedSchedules"}', NULL, '{"origin":"system","createdBy":"system","reason":"schedule-watchdog","createdAt":"2026-11-25T00:00:00.000Z"}', NULL, '2026-11-25T00:00:00.000Z', '2026-11-25T00:00:00.000Z', '2026-11-25T00:00:00.000Z')`,
  `INSERT OR IGNORE INTO unified_schedules (id, kind, state, callback, operation, definition_json, owner_login, provenance_json, alarm_id, paused_at, created_at, updated_at) VALUES ('daily-qa-sweep', 'goal', 'active', NULL, 'qa.run_sweep', '{"budgetCents":500,"cron":"0 6 * * *","enabled":true,"id":"daily-qa-sweep","name":"Daily QA sweep","operation":"qa.run_sweep"}', NULL, NULL, NULL, NULL, '2026-11-25T00:00:00.000Z', '2026-11-25T00:00:00.000Z'), ('opportunity-hunt', 'goal', 'active', NULL, 'search.opportunity_hunt', '{"budgetCents":1000,"cron":"0 7 * * *","enabled":true,"id":"opportunity-hunt","name":"Opportunity hunt","operation":"search.opportunity_hunt"}', NULL, NULL, NULL, NULL, '2026-11-25T00:00:00.000Z', '2026-11-25T00:00:00.000Z'), ('daily-social-post', 'goal', 'paused', NULL, 'social.publish', '{"budgetCents":1,"cron":"0 9 * * 1-5","enabled":false,"id":"daily-social-post","name":"Daily social post","operation":"social.publish","timeZone":"America/New_York"}', NULL, NULL, NULL, NULL, '2026-11-25T00:00:00.000Z', '2026-11-25T00:00:00.000Z'), ('resource-daily-rollup', 'goal', 'active', NULL, 'resource.rollup_daily', '{"budgetCents":1,"cron":"30 1 * * *","enabled":true,"id":"resource-daily-rollup","name":"SessionStore daily resource rollup","operation":"resource.rollup_daily","timeZone":"UTC"}', NULL, NULL, NULL, NULL, '2026-11-25T00:00:00.000Z', '2026-11-25T00:00:00.000Z'), ('resource-cap-alert', 'goal', 'active', NULL, 'resource.cap_alert', '{"budgetCents":1,"cron":"0 0 * * *","enabled":true,"id":"resource-cap-alert","name":"SessionStore 70% cap alert","operation":"resource.cap_alert","timeZone":"UTC"}', NULL, NULL, NULL, NULL, '2026-11-25T00:00:00.000Z', '2026-11-25T00:00:00.000Z'), ('resource-dashboard-comparison', 'goal', 'active', NULL, 'resource.dashboard_comparison', '{"budgetCents":1,"cron":"0 2 * * *","enabled":true,"id":"resource-dashboard-comparison","name":"SessionStore dashboard comparison","operation":"resource.dashboard_comparison","timeZone":"UTC"}', NULL, NULL, NULL, NULL, '2026-11-25T00:00:00.000Z', '2026-11-25T00:00:00.000Z'), ('index-refresh-wikipedia', 'goal', 'active', NULL, 'index.refresh_wikipedia', '{"budgetCents":1,"cron":"0 4 * * 0","enabled":true,"id":"index-refresh-wikipedia","name":"Index-list refresh (Wikipedia)","operation":"index.refresh_wikipedia","timeZone":"UTC"}', NULL, NULL, NULL, NULL, '2026-11-25T00:00:00.000Z', '2026-11-25T00:00:00.000Z'), ('index-refresh-holdings', 'goal', 'paused', NULL, 'index.refresh_holdings', '{"budgetCents":1,"cron":"0 3 * * *","enabled":false,"id":"index-refresh-holdings","name":"Index-list refresh (ETF holdings)","operation":"index.refresh_holdings","timeZone":"UTC"}', NULL, NULL, NULL, NULL, '2026-11-25T00:00:00.000Z', '2026-11-25T00:00:00.000Z'), ('autopilot-monthly-evaluation', 'goal', 'active', NULL, 'autopilot.evaluate', '{"budgetCents":1,"cron":"0 9 1 * *","enabled":true,"id":"autopilot-monthly-evaluation","name":"Autopilot monthly evaluation","operation":"autopilot.evaluate","timeZone":"UTC"}', NULL, NULL, NULL, NULL, '2026-11-25T00:00:00.000Z', '2026-11-25T00:00:00.000Z')`
];

const FIXTURE_PATH = path.join(
  path.dirname(fileURLToPath(import.meta.url)),
  "schema_component_d1_expected_model.json",
);

function expectedD1Model(): SchemaModel {
  if (process.env.SCHEMA_D1_FIXTURE_WRITE === "1") {
    const instance = new InMemorySchemaInstance();
    for (const migration of [...ALL_MIGRATIONS].sort(
      (a, b) => a.version - b.version,
    )) {
      instance.exec(migration.sql);
    }
    const model = instance.introspect() as SchemaModel;
    writeFileSync(FIXTURE_PATH, `${JSON.stringify(model, null, 2)}\n`);
    console.log(`d1 fixture written to ${FIXTURE_PATH}`);
    return model;
  }
  return JSON.parse(readFileSync(FIXTURE_PATH, "utf8")) as SchemaModel;
}

describe("D1 catalogue — migrationRunner delegates (#4282 P1)", () => {
  it("catalogues all 311 runner statements: 292 schema + 19 seed", () => {
    const catalogue = buildD1Catalogue();
    // #5086 adds migration 0070 (otel_config_overrides table): 224 → 225.
    // #4767 adds migrations 0071/0072 (4 D1 ALTERs): 225 → 229.
    // #4204 adds migration 0073 (D1 job_run_records recent-read index): 229 → 230.
    // #5865 adds migration 0074 (definition history: table + backfill): 230 → 232.
    // #3185 bridge adds migration 0077 (agent_usage_events mirror: table + 2 indexes): 234 → 237.
    // #5423 adds migration 0078 (agent_tenant_settings turn_step_timeout_ms column): 237 → 238.
    // #5425 adds migration 0079 (agent_tenant_settings SLO threshold columns): 238 → 240.
    // #6072 adds migration 0080 (agent_screener_task_entries table): 240 → 241.
    // #6099 adds migration 0081 (job_run_records tenant_id + projected_at_ms +
    // unique identity index): 241 → 244.
    // #6141 adds migration 0082 (referral trial-extension: 6 rule columns + ledger table + 2 indexes): 244 → 253.
    // #6028/#6202 adds migration 0083 (job_stage_events table + 1 index): 253 → 255.
    // #5102 adds migration 0084 (job_run_records binding tuple: 4 ALTERs + 1 index): 255 → 260.
    // #6151 S3 adds migration 0085 (saved nav presets: 2 tables + 2 indexes): 260 → 264.
    // #6006 adds migration 0086 (job_run_records outcome facts: 9 ALTERs): 264 → 273.
    // #6151 S4 adds migration 0087 (nav admin config: 3 tables + 1 index): 273 → 277.
    // #5160 adds migration 0088 (IDP attributes profile: rebuild + index table): 273 → 279.
    // #6102 adds migration 0089 (mas_events D1 table + six indexes): 283 → 290.
    // #6557 adds migrations 0090/0091 (instance provenance carrier + four
    // record provenance columns): 290 → 295.
    // #6503 adds migration 0092 (D1 unified_schedules table + 3 indexes + 6 seeds): 295 → 305.
    // #6101 adds migration 0093 (run-record identity columns + carrier-table drop): 305 → 311.
    // Union: 311 (schema 292, seeds 19).
    expect(D1_CATALOGUE_ENTRIES.length).toBe(311);
    expect(catalogue.size()).toBe(311);
    expect(catalogue.byKind("schema").length).toBe(292);    expect(catalogue.byKind("seed").length).toBe(19);
    const verbs = new Map<string, number>();
    const classify = (statement: string): string => {
      const upper = statement.trim().toUpperCase();
      for (const verb of [
        "CREATE UNIQUE INDEX",
        "CREATE TABLE",
        "CREATE INDEX",
        "ALTER TABLE",
        "DROP TABLE",
        "INSERT OR IGNORE",
        "INSERT INTO",
        "UPDATE",
      ]) {
        if (upper.startsWith(verb)) return verb;
      }
      return "OTHER";
    };
    for (const entry of D1_CATALOGUE_ENTRIES) {
      const validation = validateCatalogueEntry(entry);
      expect(validation.valid).toBe(true);
      const verb = classify(entry.statement);
      verbs.set(verb, (verbs.get(verb) ?? 0) + 1);
    }
    expect(verbs.get("CREATE TABLE")).toBe(116);
    expect(verbs.get("CREATE INDEX")).toBe(69);
    expect(verbs.get("CREATE UNIQUE INDEX")).toBe(11);
    // #6101 adds migration 0093 (run-record identity columns: 5
    // ALTERs + the carrier-table drop): ALTER 88 → 93, DROP 2 → 3.
    expect(verbs.get("ALTER TABLE")).toBe(93);    expect(verbs.get("DROP TABLE")).toBe(3);
    expect(verbs.get("INSERT OR IGNORE")).toBe(14);
    expect(verbs.get("INSERT INTO")).toBe(2);
    expect(verbs.get("UPDATE")).toBe(3);
  });

  it("every migration version has a code list matching the base count, with no orphan entries", () => {
    const versions = Object.keys(D1_MIGRATION_CODES)
      .map(Number)
      .sort((a, b) => a - b);
    // 0084 is F5's migration (job_run_records binding columns,
    // #5102), merged 2026-11-23 as f7b55d2 — the gap is filled and
    // versions run 1–87 contiguously (#6006's outcome facts were
    // renumbered 0083 -> 0086 on rebase: main took 0083-0085; #6151 S4
    // renumbered 0086 -> 0087: main took 0086 for #6006).
    // #5160's IDP profile renumbered 0086 -> 0087, then 0087 -> 0088
    // on rebase: main took 0086 for the outcome facts, then 0087
    // for the nav admin config).
    // #6102 adds migration 0089 (mas_events D1 table + six indexes).
    // #6557 adds migrations 0090/0091 (provenance).
    // #6503 adds migration 0092 (unified_schedules D1 table + goals
    // seed; renumbered 0089 -> 0092 on rebase: main took 0089-0091).
    expect(versions).toEqual(
      Array.from({ length: 93 }, (_, i) => i + 1),
    );    const allCodes = new Set<string>();
    for (const version of versions) {
      const codes = D1_MIGRATION_CODES[version];
      expect(codes.length).toBe(D1_MIGRATION_STATEMENT_COUNTS[version]);
      for (const code of codes) {
        expect(allCodes.has(code)).toBe(false);
        allCodes.add(code);
      }
    }
    const entryCodes = new Set(D1_CATALOGUE_ENTRIES.map((e) => e.code));
    // Issue #6503 step 7 — the five system-schedule seeds are
    // Recreate steps, not migration-applied: a fresh store starts
    // empty and the onStart reconcile seeds them, so they are the
    // one deliberate exception to the no-orphan rule (the goals
    // seed IS migration-applied, as before).
    const recreateOnlyCodes = new Set([
      "seed.d1.unified_schedules.insert_token_renewal",
      "seed.d1.unified_schedules.insert_retention",
      "seed.d1.unified_schedules.insert_nightly_research",
      "seed.d1.unified_schedules.insert_sweep_stale_async_jobs",
      "seed.d1.unified_schedules.insert_schedule_watchdog",
    ]);
    for (const code of recreateOnlyCodes) {
      expect(entryCodes.has(code)).toBe(true);
      entryCodes.delete(code);
    }
    expect(allCodes).toEqual(entryCodes);
  });

  it("the 19 seed entries carry the exact base seed statements", () => {
    const catalogue = buildD1Catalogue();
    const seedStatements = catalogue
      .byKind("seed")
      .map((entry) => entry.statement)
      .sort();
    expect(seedStatements).toEqual([...D1_SEED_STATEMENTS].sort());
    for (const entry of catalogue.byKind("seed")) {
      expect(entry.code.startsWith("seed.d1.")).toBe(true);
      expect(entry.form).toBe("literal");
    }
  });

  it("each migration's sql is assembled from its catalogue codes, in order", () => {
    const catalogue = buildD1Catalogue();
    for (const migration of ALL_MIGRATIONS) {
      const codes = D1_MIGRATION_CODES[migration.version];
      const expected = codes.map((code) => catalogue.get(code).statement);
      expect(splitStatements(migration.sql)).toEqual(expected);
      expect(d1MigrationSql(migration.version)).toBe(migration.sql);
    }
  });

  it("each migration's sql is byte-identical to the base (sha256 pin)", () => {
    for (const migration of ALL_MIGRATIONS) {
      const digest = createHash("sha256")
        .update(migration.sql, "utf8")
        .digest("hex");
      expect(digest).toBe(D1_MIGRATION_SQL_SHA256[migration.version]);
    }
  });

  it("equality pin: the catalogue builds the base D1 schema exactly (D1 plane)", async () => {
    const catalogue = buildD1Catalogue();
    const expected = expectedD1Model();
    const { diff, report } = await runEqualityCheck(catalogue, expected);
    expect(report).toBe(
      "schema diff: no differences — the catalogue-built schema equals the expected schema",
    );
    expect(diff.missingTables).toEqual([]);
    expect(diff.extraTables).toEqual([]);
    expect(diff.missingIndexes).toEqual([]);
    expect(diff.extraIndexes).toEqual([]);
    expect(diff.missingColumns).toEqual([]);
    expect(diff.extraColumns).toEqual([]);
    expect(diff.changedColumns).toEqual([]);
    expect(diff.changedIndexes).toEqual([]);
    expect(diff.missingConstraints).toEqual([]);
    expect(diff.extraConstraints).toEqual([]);
  });
});
