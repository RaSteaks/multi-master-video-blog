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

const expectedTables = {
  posts: [
    "id",
    "title",
    "slug",
    "summary",
    "content",
    "cover_image",
    "tags",
    "category",
    "published",
    "created_at",
    "updated_at"
  ],
  video_projects: [
    "id",
    "title",
    "slug",
    "description",
    "cover_image",
    "poster_image",
    "category",
    "tags",
    "published",
    "sort_order",
    "created_at",
    "updated_at"
  ],
  video_masters: [
    "id",
    "project_id",
    "label",
    "type",
    "hls_url",
    "file_url",
    "codec",
    "resolution_width",
    "resolution_height",
    "color_space",
    "transfer_function",
    "bit_depth",
    "bitrate_mbps",
    "dolby_profile",
    "dolby_level",
    "dolby_compatibility_id",
    "dolby_rpu_present",
    "dolby_el_present",
    "dolby_bl_present",
    "is_default",
    "sort_order",
    "status",
    "uploaded_at",
    "notes",
    "created_at",
    "updated_at"
  ]
};

const expectedRelations = [
  ["posts", "cover_image", "directus_files"],
  ["video_projects", "cover_image", "directus_files"],
  ["video_projects", "poster_image", "directus_files"],
  ["video_masters", "project_id", "video_projects"]
];

if (!fs.existsSync(databasePath)) {
  console.error(`Database not found: ${databasePath}`);
  process.exit(1);
}

const db = new sqlite3.Database(databasePath);

function all(sql, params = []) {
  return new Promise((resolve, reject) => {
    db.all(sql, params, (error, rows) => {
      if (error) {
        reject(error);
        return;
      }

      resolve(rows);
    });
  });
}

async function tableColumns(tableName) {
  const columns = await all(`pragma table_info(${tableName})`);
  return columns.map((column) => column.name);
}

async function main() {
  const tables = await all(
    "select name from sqlite_master where type = 'table' order by name"
  );
  const tableNames = new Set(tables.map((table) => table.name));

  for (const [tableName, expectedColumns] of Object.entries(expectedTables)) {
    if (!tableNames.has(tableName)) {
      throw new Error(`Missing table: ${tableName}`);
    }

    const columns = await tableColumns(tableName);
    const missingColumns = expectedColumns.filter(
      (column) => !columns.includes(column)
    );

    if (missingColumns.length > 0) {
      throw new Error(`${tableName} missing columns: ${missingColumns.join(", ")}`);
    }

    console.log(`${tableName}=ok columns=${columns.length}`);
  }

  const collections = await all(
    "select collection from directus_collections where collection in ('posts', 'video_projects', 'video_masters') order by collection"
  );
  const fields = await all(
    "select collection, field from directus_fields where collection in ('posts', 'video_projects', 'video_masters') order by collection, field"
  );
  const relations = await all(
    "select many_collection, many_field, one_collection from directus_relations order by many_collection, many_field"
  );

  for (const [collection, field, relatedCollection] of expectedRelations) {
    const exists = relations.some(
      (relation) =>
        relation.many_collection === collection &&
        relation.many_field === field &&
        relation.one_collection === relatedCollection
    );

    if (!exists) {
      throw new Error(
        `Missing relation: ${collection}.${field} -> ${relatedCollection}`
      );
    }
  }

  if (
    !fields.some(
      (field) =>
        field.collection === "video_projects" && field.field === "masters"
    )
  ) {
    throw new Error("Missing Directus alias field: video_projects.masters");
  }

  console.log(`directus_collections=${collections.length}`);
  console.log(`directus_fields=${fields.length}`);
  console.log(`directus_relations=${expectedRelations.length}`);
  console.log("cms_schema=ok");
}

main()
  .catch((error) => {
    console.error(error);
    process.exitCode = 1;
  })
  .finally(() => {
    db.close();
  });
