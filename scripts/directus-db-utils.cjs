const fs = require("node:fs");
const path = require("node:path");

const ROOT = path.resolve(__dirname, "..");
const CMS_DIR = path.join(ROOT, "apps", "cms", "directus");
const DEFAULT_ENV_PATH = path.join(CMS_DIR, ".env");
const DEFAULT_SQLITE_PATH = path.join(CMS_DIR, "database", "data.db");

function readEnv(filePath = DEFAULT_ENV_PATH) {
  const values = {};

  if (!fs.existsSync(filePath)) {
    throw new Error(`Directus .env not found: ${filePath}`);
  }

  for (const line of fs.readFileSync(filePath, "utf8").split(/\r?\n/)) {
    const trimmed = line.trim();

    if (!trimmed || trimmed.startsWith("#")) {
      continue;
    }

    const separator = trimmed.indexOf("=");
    if (separator === -1) {
      continue;
    }

    values[trimmed.slice(0, separator)] = unquoteEnvValue(
      trimmed.slice(separator + 1)
    );
  }

  return values;
}

function unquoteEnvValue(value) {
  if (
    (value.startsWith('"') && value.endsWith('"')) ||
    (value.startsWith("'") && value.endsWith("'"))
  ) {
    return value.slice(1, -1);
  }

  return value;
}

function loadDirectusEnv(filePath = DEFAULT_ENV_PATH) {
  return { ...readEnv(filePath), ...process.env };
}

function normalizeDbClient(value) {
  const client = String(value || "sqlite3").trim().toLowerCase();

  if (client === "sqlite" || client === "sqlite3") {
    return "sqlite";
  }

  if (client === "pg" || client === "postgres" || client === "postgresql") {
    return "pg";
  }

  return client;
}

function sqliteDatabasePath(env) {
  const filename = env.DB_FILENAME || "./database/data.db";
  return path.isAbsolute(filename) ? filename : path.resolve(CMS_DIR, filename);
}

function postgresSchema(env) {
  const explicit = env.DB_SCHEMA || env.DB_SEARCH_PATH;
  if (!explicit) {
    return "public";
  }

  return explicit.split(",")[0].trim() || "public";
}

function postgresConfig(env) {
  const connectionString = env.DB_CONNECTION_STRING || env.DATABASE_URL || null;
  const ssl = parseBoolean(env.DB_SSL)
    ? { rejectUnauthorized: parseBoolean(env.DB_SSL_REJECT_UNAUTHORIZED, true) }
    : false;

  if (connectionString) {
    return {
      connectionString,
      ssl
    };
  }

  return {
    host: env.DB_HOST || "127.0.0.1",
    port: Number(env.DB_PORT || 5432),
    database: env.DB_DATABASE,
    user: env.DB_USER,
    password: env.DB_PASSWORD,
    ssl
  };
}

function parseBoolean(value, defaultValue = false) {
  if (value == null || value === "") {
    return defaultValue;
  }

  return ["1", "true", "yes", "on"].includes(String(value).toLowerCase());
}

function quoteIdent(value) {
  return `"${String(value).replace(/"/g, '""')}"`;
}

function qualifiedTable(schema, table) {
  return `${quoteIdent(schema)}.${quoteIdent(table)}`;
}

async function openDirectusDatabase(env = loadDirectusEnv()) {
  const type = normalizeDbClient(env.DB_CLIENT);

  if (type === "sqlite") {
    const sqlite3 = require("sqlite3").verbose();
    const databasePath = sqliteDatabasePath(env);

    if (!fs.existsSync(databasePath)) {
      throw new Error(`Database not found: ${databasePath}`);
    }

    const db = new sqlite3.Database(databasePath);
    return {
      type,
      name: "SQLite Database",
      path: databasePath,
      tableRef: (table) => quoteIdent(table),
      all: (sql, params = []) =>
        new Promise((resolve, reject) => {
          db.all(sql, params, (error, rows) =>
            error ? reject(error) : resolve(rows)
          );
        }),
      get: (sql, params = []) =>
        new Promise((resolve, reject) => {
          db.get(sql, params, (error, row) =>
            error ? reject(error) : resolve(row)
          );
        }),
      close: () =>
        new Promise((resolve, reject) => {
          db.close((error) => (error ? reject(error) : resolve()));
        }),
      listTables: async () => {
        const rows = await new Promise((resolve, reject) => {
          db.all(
            "select name from sqlite_master where type = 'table' and name not like 'sqlite_%' order by name",
            (error, rows) => (error ? reject(error) : resolve(rows))
          );
        });
        return rows.map((row) => row.name);
      },
      tableColumns: async (table) => {
        const rows = await new Promise((resolve, reject) => {
          db.all(`pragma table_info(${quoteIdent(table)})`, (error, rows) =>
            error ? reject(error) : resolve(rows)
          );
        });
        return rows.map((row) => row.name);
      }
    };
  }

  if (type === "pg") {
    const { Client } = require("pg");
    const schema = postgresSchema(env);
    const client = new Client(postgresConfig(env));
    await client.connect();

    return {
      type,
      name: "PostgreSQL Database",
      schema,
      path: `${postgresConfigLabel(env)} schema=${schema}`,
      tableRef: (table) => qualifiedTable(schema, table),
      all: async (sql, params = []) => (await client.query(sql, params)).rows,
      get: async (sql, params = []) =>
        (await client.query(sql, params)).rows[0] || null,
      close: () => client.end(),
      listTables: async () => {
        const rows = await client.query(
          [
            "select table_name",
            "from information_schema.tables",
            "where table_schema = $1 and table_type = 'BASE TABLE'",
            "order by table_name"
          ].join(" "),
          [schema]
        );
        return rows.rows.map((row) => row.table_name);
      },
      tableColumns: async (table) => {
        const rows = await client.query(
          [
            "select column_name",
            "from information_schema.columns",
            "where table_schema = $1 and table_name = $2",
            "order by ordinal_position"
          ].join(" "),
          [schema, table]
        );
        return rows.rows.map((row) => row.column_name);
      }
    };
  }

  throw new Error(`Unsupported DB_CLIENT: ${env.DB_CLIENT || "(empty)"}`);
}

function postgresConfigLabel(env) {
  if (env.DB_CONNECTION_STRING || env.DATABASE_URL) {
    return env.DB_CONNECTION_STRING ? "DB_CONNECTION_STRING" : "DATABASE_URL";
  }

  return `${env.DB_HOST || "127.0.0.1"}:${env.DB_PORT || 5432}/${
    env.DB_DATABASE || "(missing database)"
  }`;
}

module.exports = {
  CMS_DIR,
  DEFAULT_ENV_PATH,
  DEFAULT_SQLITE_PATH,
  ROOT,
  loadDirectusEnv,
  normalizeDbClient,
  openDirectusDatabase,
  postgresConfig,
  postgresSchema,
  qualifiedTable,
  quoteIdent,
  readEnv,
  sqliteDatabasePath
};
