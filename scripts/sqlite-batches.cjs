const { quoteIdent } = require("./directus-db-utils.cjs");

/** Keyset pagination bounds memory and avoids increasingly expensive OFFSET scans. */
async function* sqliteBatches(sqliteAll, table, keys, batchSize = 200) {
  if (!keys.length) throw new Error(`${table} needs a primary key for bounded migration.`);
  let previous;
  const columns = keys.map(quoteIdent).join(", ");
  while (true) {
    const where = previous ? ` where (${columns}) > (${keys.map(() => "?").join(", ")})` : "";
    const rows = await sqliteAll(`select * from ${quoteIdent(table)}${where} order by ${columns} limit ?`, [...(previous || []), batchSize]);
    if (!rows.length) return;
    previous = keys.map(key => rows.at(-1)[key]);
    if (previous.some(value => value == null)) throw new Error(`${table} contains a null migration key.`);
    yield rows;
    if (rows.length < batchSize) return;
  }
}

module.exports = { sqliteBatches };
