const { openDirectusDatabase, quoteIdent } = require("./directus-db-utils.cjs");
const collections = require("../config/private-cms-collections.json");

/** Seal legacy anonymous grants before Directus 12 can listen without licensed row rules. */
async function directusPublicAccess(env, { apply = false } = {}) {
  const db = await openDirectusDatabase(env, { connectionTimeoutMillis: 5000, query_timeout: 5000, statement_timeout: 5000 });
  try {
    const parameter = index => db.type === "pg" ? `$${index}` : "?";
    const where = `${quoteIdent("policy")} in (select ${quoteIdent("policy")} from ${db.tableRef("directus_access")} where ${quoteIdent("role")} is null and ${quoteIdent("user")} is null) and ${quoteIdent("collection")} in (${collections.map((_, i) => parameter(i + 1)).join(",")})`;
    if (apply) {
      // This runs only after the explicit bootstrap/migration operation, before CMS startup.
      await db.all(`delete from ${db.tableRef("directus_permissions")} where ${where}`, collections);
    } else {
      const rows = await db.all(`select ${quoteIdent("id")} from ${db.tableRef("directus_permissions")} where ${where} limit 1`, collections);
      if (rows.length) throw new Error("Legacy anonymous CMS grants remain. Run bootstrap:cms and setup:cms-schema before starting this release.");
    }
  } finally { await db.close(); }
}
module.exports = { directusPublicAccess };
