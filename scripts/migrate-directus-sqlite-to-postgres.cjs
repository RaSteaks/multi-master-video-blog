const fs = require("node:fs");
const path = require("node:path");
const sqlite3 = require("sqlite3").verbose();
const { Client } = require("pg");
const {
  DEFAULT_ENV_PATH,
  DEFAULT_SQLITE_PATH,
  loadDirectusEnv,
  normalizeDbClient,
  postgresConfig,
  postgresSchema,
  qualifiedTable,
  quoteIdent
} = require("./directus-db-utils.cjs");

const HELP = `
Usage:
  node scripts/migrate-directus-sqlite-to-postgres.cjs --confirm-replace

Options:
  --confirm-replace     Required. Truncates all tables in the target PostgreSQL schema.
  --source <path>       SQLite source database. Defaults to apps/cms/directus/database/data.db.
  --env <path>          Directus env file. Defaults to apps/cms/directus/.env.
  --schema <schema>     PostgreSQL schema. Defaults to DB_SCHEMA, DB_SEARCH_PATH, or public.
  --help                Show this help.

Before running:
  1. Back up SQLite, uploads, and the PostgreSQL target database.
  2. Point apps/cms/directus/.env at PostgreSQL.
  3. Run npm run bootstrap:cms.
  4. Start Directus and run npm run setup:cms-schema.
  5. Stop Directus, then run this script with --confirm-replace.
`.trim();

function parseArgs(argv) {
  const options = {
    confirmReplace: false,
    envPath: DEFAULT_ENV_PATH,
    sourcePath: DEFAULT_SQLITE_PATH,
    schema: null,
    help: false
  };

  for (let index = 0; index < argv.length; index += 1) {
    const arg = argv[index];

    if (arg === "--confirm-replace") {
      options.confirmReplace = true;
      continue;
    }

    if (arg === "--help" || arg === "-h") {
      options.help = true;
      continue;
    }

    if (arg === "--env") {
      options.envPath = readArgValue(argv, index, arg);
      index += 1;
      continue;
    }

    if (arg === "--source") {
      options.sourcePath = readArgValue(argv, index, arg);
      index += 1;
      continue;
    }

    if (arg === "--schema") {
      options.schema = readArgValue(argv, index, arg);
      index += 1;
      continue;
    }

    throw new Error(`Unknown argument: ${arg}`);
  }

  options.envPath = path.resolve(options.envPath);
  options.sourcePath = path.resolve(options.sourcePath);
  return options;
}

function readArgValue(argv, index, name) {
  const value = argv[index + 1];
  if (!value || value.startsWith("--")) {
    throw new Error(`${name} requires a value.`);
  }

  return value;
}

async function main() {
  const options = parseArgs(process.argv.slice(2));

  if (options.help) {
    console.log(HELP);
    return;
  }

  if (!options.confirmReplace) {
    throw new Error(
      "Refusing to replace PostgreSQL data without --confirm-replace."
    );
  }

  if (!fs.existsSync(options.sourcePath)) {
    throw new Error(`SQLite source database not found: ${options.sourcePath}`);
  }

  const env = loadDirectusEnv(options.envPath);
  const dbClient = normalizeDbClient(env.DB_CLIENT);

  if (dbClient !== "pg" && !env.DB_CONNECTION_STRING && !env.DATABASE_URL) {
    throw new Error(
      "Directus .env must be configured for PostgreSQL before migration."
    );
  }

  if (!env.DB_CONNECTION_STRING && !env.DATABASE_URL && !env.DB_DATABASE) {
    throw new Error("DB_DATABASE is required when no connection string is set.");
  }

  const schema = options.schema || postgresSchema(env);
  const sqlite = await openSqlite(options.sourcePath);
  const pg = new Client(postgresConfig(env));

  await pg.connect();

  try {
    const sourceTables = await listSqliteTables(sqlite);
    const targetTables = await listPostgresTables(pg, schema);

    if (sourceTables.length === 0) {
      throw new Error("SQLite source has no tables.");
    }

    if (targetTables.length === 0) {
      throw new Error(
        `PostgreSQL schema ${schema} has no tables. Run Directus bootstrap and setup:cms-schema first.`
      );
    }

    const missingTargetTables = sourceTables.filter(
      (table) => !targetTables.includes(table)
    );

    if (missingTargetTables.length > 0) {
      throw new Error(
        [
          "PostgreSQL target is missing source tables:",
          missingTargetTables.join(", "),
          "Run npm run bootstrap:cms, start Directus, and run npm run setup:cms-schema before migration."
        ].join(" ")
      );
    }

    const extraTargetTables = targetTables.filter(
      (table) => !sourceTables.includes(table)
    );
    const targetColumnMaps = await loadTargetColumnMaps(pg, schema, sourceTables);
    const sourceColumnMaps = await loadSourceColumnMaps(sqlite, sourceTables);
    const primaryKeys = await loadPrimaryKeys(pg, schema, sourceTables);
    const foreignKeys = await listPostgresForeignKeys(pg, schema);
    const deferredForeignKeys = nullableForeignKeys(
      foreignKeys,
      sourceTables,
      targetColumnMaps
    );
    const insertOrder = sortTablesByForeignKeys(
      sourceTables,
      foreignKeys.filter((key) => !deferredForeignKeys.includes(key))
    );
    const deferredColumnMap = deferredColumnsByTable(deferredForeignKeys);

    validateColumns(sourceColumnMaps, targetColumnMaps);

    console.log(`source=${options.sourcePath}`);
    console.log(`target_schema=${schema}`);
    console.log(`source_tables=${sourceTables.length}`);
    console.log(`target_tables=${targetTables.length}`);
    console.log(`extra_target_tables=${extraTargetTables.join(",") || "none"}`);
    console.log(
      `deferred_nullable_foreign_keys=${deferredForeignKeys.length}`
    );
    console.log(
      "replace_warning=all PostgreSQL target schema tables will be truncated"
    );

    await pg.query("BEGIN");

    try {
      await truncateTargetSchema(pg, schema, targetTables);

      for (const table of insertOrder) {
        const rows = await sqliteAll(
          sqlite,
          `select * from ${quoteIdent(table)}`
        );
        const columns = sourceColumnMaps.get(table).map((column) => column.name);
        const targetColumns = targetColumnMaps.get(table);
        const deferredColumns = deferredColumnMap.get(table) || new Set();

        await insertRows(
          pg,
          schema,
          table,
          columns,
          targetColumns,
          rows,
          deferredColumns
        );
        console.log(`${table}=imported rows=${rows.length}`);
      }

      await restoreDeferredForeignKeys(
        pg,
        sqlite,
        schema,
        deferredColumnMap,
        sourceColumnMaps,
        targetColumnMaps,
        primaryKeys
      );
      await resetSequences(pg, schema);
      await verifyCounts(pg, sqlite, schema, sourceTables);
      await pg.query("COMMIT");
    } catch (error) {
      await pg.query("ROLLBACK");
      throw error;
    }

    console.log("directus_sqlite_to_postgres_migration=ok");
  } finally {
    await Promise.allSettled([closeSqlite(sqlite), pg.end()]);
  }
}

function openSqlite(databasePath) {
  return new Promise((resolve, reject) => {
    const db = new sqlite3.Database(
      databasePath,
      sqlite3.OPEN_READONLY,
      (error) => (error ? reject(error) : resolve(db))
    );
  });
}

function closeSqlite(db) {
  return new Promise((resolve, reject) => {
    db.close((error) => (error ? reject(error) : resolve()));
  });
}

function sqliteAll(db, sql, params = []) {
  return new Promise((resolve, reject) => {
    db.all(sql, params, (error, rows) => (error ? reject(error) : resolve(rows)));
  });
}

function sqliteGet(db, sql, params = []) {
  return new Promise((resolve, reject) => {
    db.get(sql, params, (error, row) => (error ? reject(error) : resolve(row)));
  });
}

async function listSqliteTables(db) {
  const rows = await sqliteAll(
    db,
    [
      "select name",
      "from sqlite_master",
      "where type = 'table' and name not like 'sqlite_%'",
      "order by name"
    ].join(" ")
  );

  return rows.map((row) => row.name);
}

async function listPostgresTables(pg, schema) {
  const rows = await pg.query(
    [
      "select table_name",
      "from information_schema.tables",
      "where table_schema = $1 and table_type = 'BASE TABLE'",
      "order by table_name"
    ].join(" "),
    [schema]
  );

  return rows.rows.map((row) => row.table_name);
}

async function listPostgresForeignKeys(pg, schema) {
  const rows = await pg.query(
    [
      "select",
      "tc.table_name,",
      "kcu.column_name,",
      "ccu.table_name as foreign_table_name",
      "from information_schema.table_constraints tc",
      "join information_schema.key_column_usage kcu",
      "on tc.constraint_name = kcu.constraint_name",
      "and tc.constraint_schema = kcu.constraint_schema",
      "join information_schema.constraint_column_usage ccu",
      "on ccu.constraint_name = tc.constraint_name",
      "and ccu.constraint_schema = tc.constraint_schema",
      "where tc.constraint_type = 'FOREIGN KEY'",
      "and tc.table_schema = $1"
    ].join(" "),
    [schema]
  );

  return rows.rows;
}

function sortTablesByForeignKeys(tables, foreignKeys) {
  const tableSet = new Set(tables);
  const dependencies = new Map(tables.map((table) => [table, new Set()]));

  for (const key of foreignKeys) {
    if (
      tableSet.has(key.table_name) &&
      tableSet.has(key.foreign_table_name) &&
      key.table_name !== key.foreign_table_name
    ) {
      dependencies.get(key.table_name).add(key.foreign_table_name);
    }
  }

  const inserted = new Set();
  const order = [];

  while (order.length < tables.length) {
    const ready = tables
      .filter((table) => !inserted.has(table))
      .filter((table) =>
        [...dependencies.get(table)].every((dependency) =>
          inserted.has(dependency)
        )
      );

    if (ready.length === 0) {
      const remaining = tables.filter((table) => !inserted.has(table));
      throw new Error(
        `Foreign key cycle prevents deterministic import order: ${remaining.join(
          ", "
        )}`
      );
    }

    for (const table of ready) {
      inserted.add(table);
      order.push(table);
    }
  }

  return order;
}

function nullableForeignKeys(foreignKeys, tables, targetColumnMaps) {
  const tableSet = new Set(tables);

  return foreignKeys.filter((key) => {
    if (
      !tableSet.has(key.table_name) ||
      !tableSet.has(key.foreign_table_name)
    ) {
      return false;
    }

    const column = targetColumnMaps.get(key.table_name)?.get(key.column_name);
    return column?.is_nullable === "YES";
  });
}

function deferredColumnsByTable(foreignKeys) {
  const columns = new Map();

  for (const key of foreignKeys) {
    if (!columns.has(key.table_name)) {
      columns.set(key.table_name, new Set());
    }

    columns.get(key.table_name).add(key.column_name);
  }

  return columns;
}

async function loadTargetColumnMaps(pg, schema, tables) {
  const rows = await pg.query(
    [
      "select table_name, column_name, data_type, udt_name, is_nullable, column_default",
      "from information_schema.columns",
      "where table_schema = $1 and table_name = any($2::text[])",
      "order by table_name, ordinal_position"
    ].join(" "),
    [schema, tables]
  );
  const maps = new Map(tables.map((table) => [table, new Map()]));

  for (const row of rows.rows) {
    maps.get(row.table_name).set(row.column_name, row);
  }

  return maps;
}

async function loadPrimaryKeys(pg, schema, tables) {
  const rows = await pg.query(
    [
      "select kcu.table_name, kcu.column_name",
      "from information_schema.table_constraints tc",
      "join information_schema.key_column_usage kcu",
      "on tc.constraint_name = kcu.constraint_name",
      "and tc.constraint_schema = kcu.constraint_schema",
      "where tc.constraint_type = 'PRIMARY KEY'",
      "and tc.table_schema = $1",
      "and tc.table_name = any($2::text[])",
      "order by kcu.table_name, kcu.ordinal_position"
    ].join(" "),
    [schema, tables]
  );
  const keys = new Map(tables.map((table) => [table, []]));

  for (const row of rows.rows) {
    keys.get(row.table_name).push(row.column_name);
  }

  return keys;
}

async function loadSourceColumnMaps(sqlite, tables) {
  const maps = new Map();

  for (const table of tables) {
    const columns = await sqliteAll(
      sqlite,
      `pragma table_info(${quoteIdent(table)})`
    );
    maps.set(
      table,
      columns.map((column) => ({
        name: column.name,
        type: column.type
      }))
    );
  }

  return maps;
}

function validateColumns(sourceColumnMaps, targetColumnMaps) {
  for (const [table, sourceColumns] of sourceColumnMaps) {
    const targetColumns = targetColumnMaps.get(table);
    const missing = sourceColumns
      .map((column) => column.name)
      .filter((column) => !targetColumns.has(column));

    if (missing.length > 0) {
      throw new Error(
        `${table} target table is missing columns: ${missing.join(", ")}`
      );
    }
  }
}

async function truncateTargetSchema(pg, schema, tables) {
  const refs = tables.map((table) => qualifiedTable(schema, table)).join(", ");
  await pg.query(`TRUNCATE TABLE ${refs} RESTART IDENTITY CASCADE`);
  console.log(`truncated_tables=${tables.length}`);
}

async function insertRows(
  pg,
  schema,
  table,
  columns,
  targetColumns,
  rows,
  deferredColumns
) {
  if (rows.length === 0) {
    return;
  }

  const maxParameters = 50000;
  const batchSize = Math.max(1, Math.min(200, Math.floor(maxParameters / columns.length)));
  const tableRef = qualifiedTable(schema, table);
  const columnSql = columns.map(quoteIdent).join(", ");

  for (let offset = 0; offset < rows.length; offset += batchSize) {
    const batch = rows.slice(offset, offset + batchSize);
    const values = [];
    const placeholders = batch.map((row) => {
      const rowPlaceholders = columns.map((column) => {
        values.push(
          deferredColumns.has(column)
            ? null
            : convertValue(row[column], targetColumns.get(column))
        );
        return `$${values.length}`;
      });
      return `(${rowPlaceholders.join(", ")})`;
    });

    await pg.query(
      `INSERT INTO ${tableRef} (${columnSql}) VALUES ${placeholders.join(", ")}`,
      values
    );
  }
}

function convertValue(value, column) {
  if (value == null) {
    return null;
  }

  const dataType = String(column.data_type || "").toLowerCase();
  const udtName = String(column.udt_name || "").toLowerCase();
  const type = dataType || udtName;

  if (type === "boolean" || udtName === "bool") {
    return toBoolean(value);
  }

  if (type === "json" || type === "jsonb" || udtName === "json" || udtName === "jsonb") {
    return toJsonString(value);
  }

  if (
    [
      "smallint",
      "integer",
      "bigint",
      "numeric",
      "decimal",
      "real",
      "double precision"
    ].includes(type)
  ) {
    return value === "" ? null : value;
  }

  if (
    type.includes("timestamp") ||
    type === "date" ||
    type === "time without time zone" ||
    type === "time with time zone"
  ) {
    return convertTemporalValue(value, type);
  }

  if (udtName === "uuid") {
    return value === "" ? null : value;
  }

  return value;
}

function toBoolean(value) {
  if (typeof value === "boolean") {
    return value;
  }

  if (typeof value === "number") {
    return value !== 0;
  }

  const normalized = String(value).trim().toLowerCase();
  if (["1", "true", "yes", "on"].includes(normalized)) {
    return true;
  }

  if (["0", "false", "no", "off", ""].includes(normalized)) {
    return false;
  }

  return Boolean(value);
}

function toJsonString(value) {
  if (Buffer.isBuffer(value)) {
    value = value.toString("utf8");
  }

  if (typeof value === "string") {
    const trimmed = value.trim();

    if (!trimmed) {
      return null;
    }

    try {
      return JSON.stringify(JSON.parse(trimmed));
    } catch {
      return JSON.stringify(value);
    }
  }

  return JSON.stringify(value);
}

function convertTemporalValue(value, type) {
  if (value === "") {
    return null;
  }

  if (
    typeof value === "number" ||
    (typeof value === "string" && /^\d+$/.test(value.trim()))
  ) {
    const numeric = Number(value);

    if (Number.isFinite(numeric)) {
      const milliseconds = numeric > 9999999999 ? numeric : numeric * 1000;
      const date = new Date(milliseconds);

      if (!Number.isNaN(date.getTime())) {
        if (type === "date") {
          return date.toISOString().slice(0, 10);
        }

        if (type.startsWith("time ")) {
          return date.toISOString().slice(11, 19);
        }

        return date.toISOString();
      }
    }
  }

  return value;
}

async function restoreDeferredForeignKeys(
  pg,
  sqlite,
  schema,
  deferredColumnMap,
  sourceColumnMaps,
  targetColumnMaps,
  primaryKeys
) {
  let updates = 0;

  for (const [table, deferredColumns] of deferredColumnMap) {
    const keys = primaryKeys.get(table) || [];

    if (keys.length === 0) {
      throw new Error(
        `${table} has deferred foreign keys but no primary key for restore.`
      );
    }

    const sourceColumns = sourceColumnMaps.get(table).map((column) => column.name);
    const missingKeys = keys.filter((key) => !sourceColumns.includes(key));

    if (missingKeys.length > 0) {
      throw new Error(
        `${table} source rows are missing primary key columns: ${missingKeys.join(
          ", "
        )}`
      );
    }

    const rows = await sqliteAll(sqlite, `select * from ${quoteIdent(table)}`);
    const tableRef = qualifiedTable(schema, table);
    const targetColumns = targetColumnMaps.get(table);

    for (const row of rows) {
      const setColumns = [...deferredColumns].filter(
        (column) => row[column] != null
      );

      if (setColumns.length === 0) {
        continue;
      }

      const values = [];
      const setSql = setColumns.map((column) => {
        values.push(convertValue(row[column], targetColumns.get(column)));
        return `${quoteIdent(column)} = $${values.length}`;
      });
      const whereSql = keys.map((column) => {
        values.push(convertValue(row[column], targetColumns.get(column)));
        return `${quoteIdent(column)} = $${values.length}`;
      });

      const result = await pg.query(
        `UPDATE ${tableRef} SET ${setSql.join(", ")} WHERE ${whereSql.join(
          " AND "
        )}`,
        values
      );

      if (result.rowCount !== 1) {
        throw new Error(
          `${table} deferred foreign key restore matched ${result.rowCount} rows.`
        );
      }

      updates += 1;
    }
  }

  console.log(`deferred_foreign_key_rows_restored=${updates}`);
}

async function resetSequences(pg, schema) {
  const rows = await pg.query(
    [
      "select",
      "seq_ns.nspname as sequence_schema,",
      "seq.relname as sequence_name,",
      "tbl.relname as table_name,",
      "attr.attname as column_name",
      "from pg_class seq",
      "join pg_namespace seq_ns on seq_ns.oid = seq.relnamespace",
      "join pg_depend dep on dep.objid = seq.oid",
      "join pg_class tbl on tbl.oid = dep.refobjid",
      "join pg_namespace tbl_ns on tbl_ns.oid = tbl.relnamespace",
      "join pg_attribute attr on attr.attrelid = tbl.oid and attr.attnum = dep.refobjsubid",
      "where seq.relkind = 'S'",
      "and tbl_ns.nspname = $1",
      "and dep.deptype in ('a', 'i')"
    ].join(" "),
    [schema]
  );

  for (const row of rows.rows) {
    const tableRef = qualifiedTable(schema, row.table_name);
    const maxRow = await pg.query(
      `select max(${quoteIdent(row.column_name)})::bigint as max from ${tableRef}`
    );
    const max = maxRow.rows[0].max;
    const sequenceRef = `${quoteIdent(row.sequence_schema)}.${quoteIdent(
      row.sequence_name
    )}`;

    if (max == null) {
      await pg.query("select setval($1::regclass, 1, false)", [sequenceRef]);
    } else {
      await pg.query("select setval($1::regclass, $2::bigint, true)", [
        sequenceRef,
        max
      ]);
    }
  }

  console.log(`sequences_reset=${rows.rows.length}`);
}

async function verifyCounts(pg, sqlite, schema, sourceTables) {
  for (const table of sourceTables) {
    const source = await sqliteGet(
      sqlite,
      `select count(*) as count from ${quoteIdent(table)}`
    );
    const target = await pg.query(
      `select count(*) as count from ${qualifiedTable(schema, table)}`
    );
    const sourceCount = Number(source.count);
    const targetCount = Number(target.rows[0].count);

    if (sourceCount !== targetCount) {
      throw new Error(
        `${table} row count mismatch: sqlite=${sourceCount} postgres=${targetCount}`
      );
    }

    console.log(`${table}=verified rows=${targetCount}`);
  }
}

main().catch((error) => {
  console.error(error);
  process.exitCode = 1;
});
