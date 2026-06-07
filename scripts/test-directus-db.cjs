const {
  loadDirectusEnv,
  openDirectusDatabase,
  quoteIdent
} = require("./directus-db-utils.cjs");

async function main() {
  const env = loadDirectusEnv();
  const db = await openDirectusDatabase(env);

  try {
    const tables = await db.listTables();
    const users = await db.get(
      `select count(*) as count from ${db.tableRef("directus_users")}`
    );
    const roleColumns = await db.tableColumns("directus_roles");
    const userColumns = await db.tableColumns("directus_users");
    const roles = await db.all(`select * from ${db.tableRef("directus_roles")}`);
    const policies = await db.all(
      [
        "select",
        `${quoteIdent("id")}, ${quoteIdent("name")}, ${quoteIdent(
          "admin_access"
        )}, ${quoteIdent("app_access")}`,
        `from ${db.tableRef("directus_policies")}`
      ].join(" ")
    );
    const access = await db.all(
      [
        "select",
        `${quoteIdent("id")}, ${quoteIdent("role")}, ${quoteIdent(
          "user"
        )}, ${quoteIdent("policy")}`,
        `from ${db.tableRef("directus_access")}`
      ].join(" ")
    );
    const adminUsers = await db.all(
      [
        "select",
        `${quoteIdent("email")}, ${quoteIdent("role")}`,
        `from ${db.tableRef("directus_users")}`,
        `order by ${quoteIdent("email")}`
      ].join(" ")
    );

    console.log(`database=${db.path}`);
    console.log(`db_client=${db.type}`);
    console.log(`table_count=${tables.length}`);
    console.log(`directus_users=${Number(users.count)}`);
    console.log(`role_columns=${roleColumns.join(",")}`);
    console.log(`user_columns=${userColumns.join(",")}`);
    console.log(
      `roles=${roles.map((role) => `${role.name}:${role.id}`).join(",")}`
    );
    console.log(
      `policies=${policies
        .map(
          (policy) =>
            `${policy.name}:admin=${formatBoolean(policy.admin_access)}:app=${formatBoolean(
              policy.app_access
            )}`
        )
        .join(",")}`
    );
    console.log(
      `access=${access
        .map((item) => `${item.role || item.user}->${item.policy}`)
        .join(",")}`
    );
    console.log(
      `users=${adminUsers
        .map((user) => `${user.email}:${user.role}`)
        .join(",")}`
    );
    console.log(`sample_tables=${tables.slice(0, 12).join(",")}`);

    if (tables.length === 0) {
      throw new Error("Directus database has no tables.");
    }

    if (Number(users.count) < 1) {
      throw new Error("Directus database has no admin user.");
    }
  } finally {
    await db.close();
  }
}

function formatBoolean(value) {
  if (typeof value === "boolean") {
    return value ? 1 : 0;
  }

  return value;
}

main().catch((error) => {
  console.error(error);
  process.exitCode = 1;
});
