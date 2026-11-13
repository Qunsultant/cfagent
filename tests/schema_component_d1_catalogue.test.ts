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
 *  - D1_SEED_STATEMENTS: the 11 seed-DML statements, exact text.
 *    Seeds do not change the schema model, so the equality pin cannot
 *    see them — this list is their anchor.
 *  - The expected-model fixture
 *    (tests/schema_component_d1_expected_model.json): the D1 schema
 *    model built by executing the base runner's migrations, in version
 *    order, through the P0 InMemorySchemaInstance — 97 tables, 56
 *    indexes. Regenerate only with SCHEMA_D1_FIXTURE_WRITE=1 from a
 *    clean checkout, and review the refreshed fixture in the PR diff:
 *    a refresh that changes an existing table without a migration is
 *    a defect, not a cleanup (same discipline as the grep baseline).
 *
 * Scope correction (measured on the tip, not the filing counts): the
 * runner carries 215 statements, not the filed ~148 + 5. The filing
 * counts counted only CREATE TABLE / CREATE INDEX / CREATE UNIQUE
 * INDEX lines; the runner also carries 49 ALTER TABLE statements, 1
 * DROP TABLE, and 10 seed-DML lines (the survey's 5 named seeds plus
 * 5 more in the v58 product-versions data migration, plus 10 more in
 * the v66 referral-codes migration that landed on main (534e8903) after
 * the P1 build base. All 215 are
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
};

/** The 11 seed-DML statements, exact text, measured from the base runner. */
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
  "INSERT OR IGNORE INTO agent_referral_code_rules (id, product_id, issuer, runs_per_code, reusable, expiry_days, attribution_mode, max_redemptions_per_code, max_redemptions_per_login, global_cap, redemption_count, active, created_at_ms, updated_at_ms)\n  VALUES\n    ('coderule-seed-prod-per-run-stock', 'prod-per-run-stock', 'platform_admin', 5, 0, 30, 'ledger', 1, 1, NULL, 0, 0, 0, 0),\n    ('coderule-seed-prod-per-run-goal', 'prod-per-run-goal', 'platform_admin', 5, 0, 30, 'ledger', 1, 1, NULL, 0, 0, 0, 0),\n    ('coderule-seed-prod-per-run-options', 'prod-per-run-options', 'platform_admin', 5, 0, 30, 'ledger', 1, 1, NULL, 0, 0, 0, 0),\n    ('coderule-seed-prod-per-run-strategy', 'prod-per-run-strategy', 'platform_admin', 5, 0, 30, 'ledger', 1, 1, NULL, 0, 0, 0, 0)"
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
  it("catalogues all 215 runner statements: 204 schema + 11 seed", () => {
    const catalogue = buildD1Catalogue();
    expect(D1_CATALOGUE_ENTRIES.length).toBe(215);
    expect(catalogue.size()).toBe(215);
    expect(catalogue.byKind("schema").length).toBe(204);
    expect(catalogue.byKind("seed").length).toBe(11);
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
    expect(verbs.get("CREATE TABLE")).toBe(98);
    expect(verbs.get("CREATE INDEX")).toBe(49);
    expect(verbs.get("CREATE UNIQUE INDEX")).toBe(7);
    expect(verbs.get("ALTER TABLE")).toBe(49);
    expect(verbs.get("DROP TABLE")).toBe(1);
    expect(verbs.get("INSERT OR IGNORE")).toBe(7);
    expect(verbs.get("INSERT INTO")).toBe(1);
    expect(verbs.get("UPDATE")).toBe(3);
  });

  it("every migration version has a code list matching the base count, with no orphan entries", () => {
    const versions = Object.keys(D1_MIGRATION_CODES)
      .map(Number)
      .sort((a, b) => a - b);
    expect(versions).toEqual(
      Array.from({ length: 66 }, (_, i) => i + 1).filter((v) => v !== 53),
    );
    const allCodes = new Set<string>();
    for (const version of versions) {
      const codes = D1_MIGRATION_CODES[version];
      expect(codes.length).toBe(D1_MIGRATION_STATEMENT_COUNTS[version]);
      for (const code of codes) {
        expect(allCodes.has(code)).toBe(false);
        allCodes.add(code);
      }
    }
    const entryCodes = new Set(D1_CATALOGUE_ENTRIES.map((e) => e.code));
    expect(allCodes).toEqual(entryCodes);
  });

  it("the 11 seed entries carry the exact base seed statements", () => {
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
