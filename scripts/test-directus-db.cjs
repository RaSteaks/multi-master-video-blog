const fs = require("node:fs");
const path = require("node:path");
const sqlite3 = require("sqlite3").verbose();

const databasePath = path.join(
  __dirname,
  "..",
  "apps",
  "cms",
  "directus",
  "database",
  "data.db"
);

if (!fs.existsSync(databasePath)) {
  console.error(`Database not found: ${databasePath}`);
  process.exit(1);
}

const db = new sqlite3.Database(databasePath);

function all(sql) {
  return new Promise((resolve, reject) => {
    db.all(sql, (error, rows) => {
      if (error) {
        reject(error);
        return;
      }

      resolve(rows);
    });
  });
}

function get(sql) {
  return new Promise((resolve, reject) => {
    db.get(sql, (error, row) => {
      if (error) {
        reject(error);
        return;
      }

      resolve(row);
    });
  });
}

async function main() {
  const tables = await all(
    "select name from sqlite_master where type = 'table' order by name"
  );
  const users = await get("select count(*) as count from directus_users");
  const roleColumns = await all("pragma table_info(directus_roles)");
  const userColumns = await all("pragma table_info(directus_users)");
  const roles = await all("select * from directus_roles");
  const policies = await all("select id, name, admin_access, app_access from directus_policies");
  const access = await all("select id, role, user, policy from directus_access");
  const adminUsers = await all(
    "select email, role from directus_users order by email"
  );

  console.log(`database=${databasePath}`);
  console.log(`table_count=${tables.length}`);
  console.log(`directus_users=${users.count}`);
  console.log(`role_columns=${roleColumns.map((column) => column.name).join(",")}`);
  console.log(`user_columns=${userColumns.map((column) => column.name).join(",")}`);
  console.log(`roles=${roles.map((role) => `${role.name}:${role.id}`).join(",")}`);
  console.log(
    `policies=${policies.map((policy) => `${policy.name}:admin=${policy.admin_access}:app=${policy.app_access}`).join(",")}`
  );
  console.log(
    `access=${access.map((item) => `${item.role || item.user}->${item.policy}`).join(",")}`
  );
  console.log(
    `users=${adminUsers.map((user) => `${user.email}:${user.role}`).join(",")}`
  );
  console.log(`sample_tables=${tables.slice(0, 12).map((table) => table.name).join(",")}`);

  if (tables.length === 0) {
    throw new Error("Directus database has no tables.");
  }

  if (users.count < 1) {
    throw new Error("Directus database has no admin user.");
  }
}

main()
  .catch((error) => {
    console.error(error);
    process.exitCode = 1;
  })
  .finally(() => {
    db.close();
  });
