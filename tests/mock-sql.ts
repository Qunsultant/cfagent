/**
 * In-memory Mock SQLite Storage implementing SqlStorage for unit & integration testing.
 */

import type { SqlStorage } from "../src/orm";

export class MockSqlStorage implements SqlStorage {
  private tables = new Map<string, Array<Record<string, any>>>();
  private schema = new Map<string, Array<{ name: string; type: string; pk: number }>>();

  constructor() {
    this.initDefaultSchema();
  }

  private initDefaultSchema() {
    this.schema.set("mas_categories", [
      { name: "id", type: "TEXT", pk: 1 },
      { name: "name", type: "TEXT", pk: 0 },
      { name: "slug", type: "TEXT", pk: 0 },
      { name: "description", type: "TEXT", pk: 0 },
      { name: "icon", type: "TEXT", pk: 0 },
      { name: "is_active", type: "INTEGER", pk: 0 },
      { name: "sort_order", type: "INTEGER", pk: 0 },
      { name: "created_at", type: "TEXT", pk: 0 },
      { name: "updated_at", type: "TEXT", pk: 0 },
    ]);

    this.schema.set("mas_referrals", [
      { name: "id", type: "TEXT", pk: 1 },
      { name: "session_id", type: "TEXT", pk: 0 },
      { name: "title", type: "TEXT", pk: 0 },
      { name: "url", type: "TEXT", pk: 0 },
      { name: "category", type: "TEXT", pk: 0 },
      { name: "reward_text", type: "TEXT", pk: 0 },
      { name: "clicks", type: "INTEGER", pk: 0 },
      { name: "signups", type: "INTEGER", pk: 0 },
      { name: "created_at", type: "TEXT", pk: 0 },
    ]);

    this.schema.set("mas_ads", [
      { name: "id", type: "TEXT", pk: 1 },
      { name: "title", type: "TEXT", pk: 0 },
      { name: "tagline", type: "TEXT", pk: 0 },
      { name: "sponsor", type: "TEXT", pk: 0 },
      { name: "badge", type: "TEXT", pk: 0 },
      { name: "url", type: "TEXT", pk: 0 },
      { name: "cta_text", type: "TEXT", pk: 0 },
      { name: "accent_color", type: "TEXT", pk: 0 },
      { name: "impressions", type: "INTEGER", pk: 0 },
      { name: "clicks", type: "INTEGER", pk: 0 },
      { name: "created_at", type: "TEXT", pk: 0 },
    ]);

    this.schema.set("mas_external_ads", [
      { name: "id", type: "TEXT", pk: 1 },
      { name: "name", type: "TEXT", pk: 0 },
      { name: "network", type: "TEXT", pk: 0 },
      { name: "placement", type: "TEXT", pk: 0 },
      { name: "title", type: "TEXT", pk: 0 },
      { name: "tagline", type: "TEXT", pk: 0 },
      { name: "cta_text", type: "TEXT", pk: 0 },
      { name: "target_url", type: "TEXT", pk: 0 },
      { name: "banner_image_url", type: "TEXT", pk: 0 },
      { name: "cpm_rate", type: "REAL", pk: 0 },
      { name: "cpc_rate", type: "REAL", pk: 0 },
      { name: "impressions", type: "INTEGER", pk: 0 },
      { name: "clicks", type: "INTEGER", pk: 0 },
      { name: "earnings", type: "REAL", pk: 0 },
      { name: "is_active", type: "INTEGER", pk: 0 },
      { name: "created_at", type: "TEXT", pk: 0 },
    ]);

    this.schema.set("mas_transactions", [
      { name: "id", type: "TEXT", pk: 1 },
      { name: "session_id", type: "TEXT", pk: 0 },
      { name: "action", type: "TEXT", pk: 0 },
      { name: "amount", type: "REAL", pk: 0 },
      { name: "currency", type: "TEXT", pk: 0 },
      { name: "customer", type: "TEXT", pk: 0 },
      { name: "gateway", type: "TEXT", pk: 0 },
      { name: "gateway_ref", type: "TEXT", pk: 0 },
      { name: "status", type: "TEXT", pk: 0 },
      { name: "checkout_url", type: "TEXT", pk: 0 },
      { name: "proposer_did", type: "TEXT", pk: 0 },
      { name: "authorizer_did", type: "TEXT", pk: 0 },
      { name: "proof_signature", type: "TEXT", pk: 0 },
      { name: "note", type: "TEXT", pk: 0 },
      { name: "created_at", type: "TEXT", pk: 0 },
      { name: "updated_at", type: "TEXT", pk: 0 },
      // Issue #3182: nullable tenant attribution, last (mirrors the DDL).
      { name: "tenant_id", type: "TEXT", pk: 0 },
    ]);

    this.schema.set("mas_messages", [
      { name: "id", type: "TEXT", pk: 1 },
      { name: "session_id", type: "TEXT", pk: 0 },
      { name: "role", type: "TEXT", pk: 0 },
      { name: "content", type: "TEXT", pk: 0 },
      { name: "agent", type: "TEXT", pk: 0 },
      { name: "created_at", type: "TEXT", pk: 0 },
    ]);

    this.schema.set("mas_memory", [
      { name: "key", type: "TEXT", pk: 1 },
      { name: "value", type: "TEXT", pk: 0 },
      { name: "updated_at", type: "TEXT", pk: 0 },
    ]);

    this.schema.set("mas_events", [
      { name: "id", type: "TEXT", pk: 1 },
      { name: "session_id", type: "TEXT", pk: 0 },
      { name: "type", type: "TEXT", pk: 0 },
      { name: "agent", type: "TEXT", pk: 0 },
      { name: "payload", type: "TEXT", pk: 0 },
      { name: "created_at", type: "TEXT", pk: 0 },
    ]);

    this.schema.set("mas_trades", [
      { name: "id", type: "TEXT", pk: 1 },
      { name: "session_id", type: "TEXT", pk: 0 },
      { name: "symbol", type: "TEXT", pk: 0 },
      { name: "action", type: "TEXT", pk: 0 },
      { name: "order_type", type: "TEXT", pk: 0 },
      { name: "quantity", type: "REAL", pk: 0 },
      { name: "price", type: "REAL", pk: 0 },
      { name: "total_value", type: "REAL", pk: 0 },
      { name: "status", type: "TEXT", pk: 0 },
      { name: "order_ref", type: "TEXT", pk: 0 },
      { name: "proposer_did", type: "TEXT", pk: 0 },
      { name: "authorizer_did", type: "TEXT", pk: 0 },
      { name: "proof_signature", type: "TEXT", pk: 0 },
      { name: "preview_notes", type: "TEXT", pk: 0 },
      { name: "created_at", type: "TEXT", pk: 0 },
      { name: "updated_at", type: "TEXT", pk: 0 },
    ]);

    for (const key of this.schema.keys()) {
      this.tables.set(key, []);
    }
  }

  exec(query: string, ...args: unknown[]): Iterable<unknown> {
    const q = query.trim();

    // CREATE TABLE IF NOT EXISTS
    if (q.startsWith("CREATE TABLE")) {
      return [];
    }

    // DROP TABLE [IF EXISTS] name (Issue #686: the legacy-session
    // lift drops cf_ai_chat_agent_messages on a clean import; real
    // SQLite removes the table and its rows)
    const dropMatch = q.match(/DROP\s+TABLE\s+(?:IF\s+EXISTS\s+)?(\w+)/i);
    if (dropMatch) {
      this.tables.delete(dropMatch[1]);
      this.schema.delete(dropMatch[1]);
      return [];
    }

    // SELECT name FROM sqlite_master WHERE type = 'table' AND
    // name = 'x' (Issue #686: table-existence probes — answered from
    // the mock's schema/table maps, like real SQLite's catalog)
    if (/FROM\s+sqlite_master/i.test(q)) {
      const nameArg =
        typeof args[0] === "string"
          ? args[0]
          : q.match(/name\s*=\s*'([^']+)'/i)?.[1];
      if (nameArg && (this.tables.has(nameArg) || this.schema.has(nameArg))) {
        return [{ name: nameArg }];
      }
      return [];
    }

    // ALTER TABLE name ADD COLUMN col TYPE (Issue #2178: chain
    // migration — real SQLite adds the column with NULL for existing
    // rows; the mock mirrors that in its schema map + row objects).
    const alterMatch = q.match(/ALTER\s+TABLE\s+(\w+)\s+ADD\s+COLUMN\s+(\w+)\s+(\w+)/i);
    if (alterMatch) {
      const [, tbl, col, type] = alterMatch;
      const cols = this.schema.get(tbl) || [];
      if (!cols.some((c) => c.name === col)) {
        cols.push({ name: col, type, pk: 0 });
        this.schema.set(tbl, cols);
        for (const row of this.tables.get(tbl) || []) {
          if (!(col in row)) row[col] = null;
        }
      }
      return [];
    }

    // PRAGMA table_info(tableName)
    const pragmaMatch = q.match(/PRAGMA\s+table_info\((\w+)\)/i);
    if (pragmaMatch) {
      const tbl = pragmaMatch[1];
      const cols = this.schema.get(tbl) || [];
      return cols.map((c, i) => ({
        cid: i,
        name: c.name,
        type: c.type,
        notnull: 0,
        dflt_value: null,
        pk: c.pk,
      }));
    }

    // SELECT COUNT(*) FROM table [WHERE ...]
    const countMatch = q.match(/SELECT\s+COUNT\(\*\)\s+AS\s+count\s+FROM\s+(\w+)(?:\s+WHERE\s+(.+))?/i);
    if (countMatch) {
      const tbl = countMatch[1];
      const rows = this.tables.get(tbl) || [];
      const whereClause = countMatch[2];

      if (!whereClause) {
        return [{ count: rows.length }];
      }

      const filtered = this.filterRows(rows, whereClause, args);
      return [{ count: filtered.length }];
    }

    // SELECT <cols> FROM table (supports "*" or an explicit column list;
    // issue #255 extended this from *-only so retention-style queries like
    // SELECT id FROM ... WHERE created_at < ? behave like real SQLite)
    const selectMatch = q.match(/SELECT\s+(\*|[\w\s,]+)\s+FROM\s+(\w+)(.*?)$/i);
    if (selectMatch) {
      const colSpec = selectMatch[1].trim();
      const tbl = selectMatch[2];
      const rest = selectMatch[3] || "";
      let rows = [...(this.tables.get(tbl) || [])];

      // WHERE clause
      const whereMatch = rest.match(/WHERE\s+(.+?)(?:\s+ORDER\s+BY|\s+LIMIT|\s+OFFSET|$)/i);
      let argIndex = 0;
      if (whereMatch) {
        const whereClause = whereMatch[1];
        rows = this.filterRows(rows, whereClause, args);
        // count how many ? were consumed
        const questionMarks = (whereClause.match(/\?/g) || []).length;
        argIndex += questionMarks;
      }

      // ORDER BY clause
      const orderMatch = rest.match(/ORDER\s+BY\s+(\w+)\s+(ASC|DESC)/i);
      if (orderMatch) {
        const field = orderMatch[1];
        const dir = orderMatch[2].toUpperCase();
        if (field.toLowerCase() === "rowid") {
          // Issue #2178: rowid is insertion order, not a stored
          // column — sort by the row's position in the table array.
          const indexed = rows.map((r, i) => [r, i] as const);
          indexed.sort(([, a], [, b]) => (dir === "ASC" ? a - b : b - a));
          rows = indexed.map(([r]) => r);
        } else {
          rows.sort((a, b) => {
            const valA = a[field] ?? "";
            const valB = b[field] ?? "";
            if (valA < valB) return dir === "ASC" ? -1 : 1;
            if (valA > valB) return dir === "ASC" ? 1 : -1;
            return 0;
          });
        }
      }

      // LIMIT and OFFSET
      const limitMatch = rest.match(/LIMIT\s+(\d+|\?)(?:\s+OFFSET\s+(\d+|\?))?/i);
      if (limitMatch) {
        let limit = limitMatch[1] === "?" ? Number(args[argIndex++]) : Number(limitMatch[1]);
        let offset = 0;
        if (limitMatch[2]) {
          offset = limitMatch[2] === "?" ? Number(args[argIndex++]) : Number(limitMatch[2]);
        }
        rows = rows.slice(offset, offset + limit);
      }

      if (colSpec !== "*") {
        const wanted = colSpec.split(",").map((c) => c.trim()).filter(Boolean);
        rows = rows.map((r) => Object.fromEntries(wanted.map((c) => [c, r[c]])));
      }
      return rows;
    }

    // INSERT INTO table (cols) VALUES (placeholders)
    // Issue #887: OR REPLACE is matched too — several services upsert
    // with INSERT OR REPLACE (strategy reviews, strategy weights);
    // real SQLite replaces the conflicting row, the mock must as well.
    const insertMatch = q.match(/INSERT\s+(?:OR\s+(IGNORE|REPLACE)\s+)?INTO\s+(\w+)\s*\((.*?)\)\s*VALUES\s*\((.*?)\)/i);
    if (insertMatch) {
      const tbl = insertMatch[2];
      const cols = insertMatch[3].split(",").map((c) => c.trim());
      const record: Record<string, any> = {};

      // Issue #669: value tokens may mix placeholders with literals
      // (e.g. VALUES (?, ?, 'queued', ?)) — a literal occupies its
      // column without consuming a bound argument, exactly like real
      // SQLite. Split on commas outside single quotes.
      const valueTokens: string[] = [];
      {
        let current = "";
        let inQuote = false;
        for (const ch of insertMatch[4]) {
          if (ch === "'") inQuote = !inQuote;
          if (ch === "," && !inQuote) {
            valueTokens.push(current);
            current = "";
          } else {
            current += ch;
          }
        }
        valueTokens.push(current);
      }
      let argIdx = 0;
      for (let i = 0; i < cols.length; i++) {
        const token = (valueTokens[i] ?? "?").trim();
        if (token === "?") {
          record[cols[i]] = args[argIdx++];
        } else if (token.startsWith("'") && token.endsWith("'")) {
          record[cols[i]] = token.slice(1, -1).replace(/''/g, "'");
        } else if (token.toUpperCase() === "NULL") {
          record[cols[i]] = null;
        } else if (!Number.isNaN(Number(token))) {
          record[cols[i]] = Number(token);
        } else {
          record[cols[i]] = args[argIdx++];
        }
      }

      let existing = this.tables.get(tbl);
      if (!existing) {
        existing = [];
        this.tables.set(tbl, existing);
      }

      const idCol = cols[0];
      const existsIndex = existing.findIndex((r) => r[idCol] === record[idCol]);
      if (existsIndex >= 0) {
        if ((insertMatch[1] || "").toUpperCase() === "REPLACE" || /ON\s+CONFLICT[\s\S]*DO\s+UPDATE/i.test(q)) {
          existing[existsIndex] = { ...existing[existsIndex], ...record };
        }
        // else IGNORE: keep the existing row
      } else {
        existing.push(record);
      }
      return [];
    }

    // UPDATE table SET col = ?, ... WHERE id = ?
    const updateMatch = q.match(/UPDATE\s+(\w+)\s+SET\s+(.*?)\s+WHERE\s+(.*?)$/is);
    if (updateMatch) {
      const tbl = updateMatch[1];
      const setPart = updateMatch[2];
      const wherePart = updateMatch[3];
      const rows = this.tables.get(tbl) || [];

      // Parse SET assignments
      const assignments = setPart.split(",").map((s) => s.trim());
      let argIdx = 0;
      const updates: Array<{ col: string; val: any; isExpr?: string }> = [];

      for (const assign of assignments) {
        const [col, expr] = assign.split("=").map((s) => s.trim());
        if (expr === "?") {
          updates.push({ col, val: args[argIdx++] });
        } else if (expr.includes("+")) {
          // e.g. impressions = impressions + 1
          updates.push({ col, val: null, isExpr: expr });
        } else if (expr.startsWith("'") && expr.endsWith("'")) {
          // Issue #669: literal SET assignments (e.g. status = 'running'
          // in the async-job claim UPDATE) — real SQLite applies them
          // without consuming a bound argument.
          updates.push({ col, val: expr.slice(1, -1).replace(/''/g, "'") });
        } else if (expr.toUpperCase() === "NULL") {
          updates.push({ col, val: null });
        } else if (!Number.isNaN(Number(expr))) {
          updates.push({ col, val: Number(expr) });
        }
      }

      // Filter rows to update
      const whereArgs = args.slice(argIdx);
      const targetRows = this.filterRows(rows, wherePart, whereArgs);

      for (const row of targetRows) {
        for (const u of updates) {
          if (u.isExpr) {
            row[u.col] = (Number(row[u.col]) || 0) + 1;
          } else {
            row[u.col] = u.val;
          }
        }
      }
      return [];
    }

    // DELETE FROM table [WHERE id = ?]
    const deleteMatch = q.match(/DELETE\s+FROM\s+(\w+)(?:\s+WHERE\s+(.+))?/i);
    if (deleteMatch) {
      const tbl = deleteMatch[1];
      const wherePart = deleteMatch[2];

      if (!wherePart) {
        this.tables.set(tbl, []);
        return [];
      }

      const rows = this.tables.get(tbl) || [];
      const toKeep = rows.filter((r) => !this.matchesWhere(r, wherePart, args));
      this.tables.set(tbl, toKeep);
      return [];
    }

    return [];
  }

  private filterRows(rows: Array<Record<string, any>>, whereClause: string, args: unknown[]): Array<Record<string, any>> {
    return rows.filter((r) => this.matchesWhere(r, whereClause, args));
  }

  private matchesWhere(row: Record<string, any>, whereClause: string, args: unknown[]): boolean {
    const conditions = whereClause.split(/\s+AND\s+/i);
    let argIdx = 0;

    for (const cond of conditions) {
      // OR group, e.g. "(LOWER(title) LIKE ? OR LOWER(summary) LIKE ?)":
      // any branch may match; the matching branch consumes its args.
      if (/\sOR\s/i.test(cond)) {
        const branches = cond.split(/\sOR\s/i);
        let matched = false;
        let consumed = 0;
        for (const branch of branches) {
          const r = this.matchesCondition(row, branch, args.slice(argIdx));
          if (r.matched) {
            matched = true;
            consumed = r.consumed;
            break;
          }
        }
        if (!matched) return false;
        argIdx += consumed;
        continue;
      }
      const r = this.matchesCondition(row, cond, args.slice(argIdx));
      if (!r.matched) return false;
      argIdx += r.consumed;
    }
    return true;
  }

  /** Evaluate one AND-condition; reports whether it matched and how many args it consumed. */
  private matchesCondition(
    row: Record<string, any>,
    cond: string,
    args: unknown[]
  ): { matched: boolean; consumed: number } {
    let consumed = 0;
    // IS NULL / IS NOT NULL (no args consumed).
    const nullMatch = cond.match(/(\w+)\s+IS\s+(NOT\s+)?NULL/i);
    if (nullMatch) {
      const col = nullMatch[1];
      const negated = !!nullMatch[2];
      const isNull = row[col] === null || row[col] === undefined;
      return { matched: negated ? !isNull : isNull, consumed: 0 };
    }
    const eqMatch = cond.match(/(\w+)\s*=\s*\?/);
    if (eqMatch) {
      const col = eqMatch[1];
      const val = args[consumed++];
      if (row[col] != val) return { matched: false, consumed: 0 };
      return { matched: true, consumed };
    }

    // Issue #887: equality against a single-quoted literal, as several
    // services interpolate (e.g. learnings' domain = 'x', strategy
    // reviews' decision = 'pending'). Without this branch such
    // conditions fell through to the lenient fallback and matched
    // every row; real SQLite compares the literal.
    const litMatch = cond.match(/(\w+)\s*=\s*'((?:[^']|'')*)'/);
    if (litMatch) {
      const col = litMatch[1];
      const val = litMatch[2].replace(/''/g, "'");
      if (row[col] != val) return { matched: false, consumed: 0 };
      return { matched: true, consumed };
    }

    const likeMatch = cond.match(/lower\((\w+)\)\s+LIKE\s+\?/i);
    if (likeMatch) {
      const col = likeMatch[1];
      const pattern = String(args[consumed++] || "")
        .toLowerCase()
        .replace(/%/g, "");
      const cell = String(row[col] || "").toLowerCase();
      if (!cell.includes(pattern)) return { matched: false, consumed: 0 };
      return { matched: true, consumed };
    }

    // Issue #255: comparison operators behave like real SQLite so
    // retention-style range predicates (e.g. created_at < ?) are testable.
    // ISO-8601 timestamps compare lexicographically, matching TEXT semantics.
    const cmpMatch = cond.match(/(\w+)\s*(<=|>=|<|>)\s*\?/);
    if (cmpMatch) {
      const col = cmpMatch[1];
      const op = cmpMatch[2];
      const val = args[consumed++];
      const cell = row[col];
      // Numeric when both sides are numbers; otherwise codepoint order,
      // matching SQLite BINARY collation for TEXT (ISO-8601 timestamps).
      let cmp: number;
      if (typeof cell === "number" && typeof val === "number") {
        cmp = cell - val;
      } else {
        const a = String(cell ?? "");
        const b = String(val ?? "");
        cmp = a < b ? -1 : a > b ? 1 : 0;
      }
      if (op === "<" && !(cmp < 0)) return { matched: false, consumed: 0 };
      if (op === ">" && !(cmp > 0)) return { matched: false, consumed: 0 };
      if (op === "<=" && !(cmp <= 0)) return { matched: false, consumed: 0 };
      if (op === ">=" && !(cmp >= 0)) return { matched: false, consumed: 0 };
      return { matched: true, consumed };
    }
    // Unrecognized condition: preserve the old lenient behavior.
    return { matched: true, consumed: 0 };
  }
}
