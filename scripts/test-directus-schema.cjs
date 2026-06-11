const {
  loadDirectusEnv,
  openDirectusDatabase,
  quoteIdent
} = require("./directus-db-utils.cjs");

const expectedTables = {
  posts: [
    "id",
    "title",
    "slug",
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
    "processing_mode",
    "is_derivative",
    "derived_from_master_id",
    "source_sha256",
    "display_gamut",
    "color_primaries",
    "color_transfer",
    "matrix_coefficients",
    "color_range",
    "pixel_format",
    "chroma_location",
    "hls_video_range",
    "hdr_static_metadata",
    "dolby_metadata",
    "source_probe_json",
    "output_probe_json",
    "verification_status",
    "verification_errors",
    "verified_at",
    "conversion_intent",
    "conversion_lut_or_filter",
    "uploaded_at",
    "notes",
    "created_at",
    "updated_at"
  ]
};

const expectedRelations = [
  ["posts", "cover_image", "directus_files"],
  ["video_projects", "cover_image", "directus_files"],
  ["video_masters", "project_id", "video_projects"]
];

async function main() {
  const env = loadDirectusEnv();
  const db = await openDirectusDatabase(env);

  try {
    const tables = await db.listTables();
    const tableNames = new Set(tables);

    for (const [tableName, expectedColumns] of Object.entries(expectedTables)) {
      if (!tableNames.has(tableName)) {
        throw new Error(`Missing table: ${tableName}`);
      }

      const columns = await db.tableColumns(tableName);
      const missingColumns = expectedColumns.filter(
        (column) => !columns.includes(column)
      );

      if (missingColumns.length > 0) {
        throw new Error(
          `${tableName} missing columns: ${missingColumns.join(", ")}`
        );
      }

      console.log(`${tableName}=ok columns=${columns.length}`);
    }

    const collections = await db.all(
      [
        "select",
        quoteIdent("collection"),
        `from ${db.tableRef("directus_collections")}`,
        `where ${quoteIdent("collection")} in (${
          db.type === "pg" ? "$1, $2, $3" : "?, ?, ?"
        })`,
        `order by ${quoteIdent("collection")}`
      ].join(" "),
      ["posts", "video_projects", "video_masters"]
    );
    const fields = await db.all(
      [
        "select",
        `${quoteIdent("collection")}, ${quoteIdent("field")}`,
        `from ${db.tableRef("directus_fields")}`,
        `where ${quoteIdent("collection")} in (${
          db.type === "pg" ? "$1, $2, $3" : "?, ?, ?"
        })`,
        `order by ${quoteIdent("collection")}, ${quoteIdent("field")}`
      ].join(" "),
      ["posts", "video_projects", "video_masters"]
    );
    const relations = await db.all(
      [
        "select",
        `${quoteIdent("many_collection")}, ${quoteIdent(
          "many_field"
        )}, ${quoteIdent("one_collection")}`,
        `from ${db.tableRef("directus_relations")}`,
        `order by ${quoteIdent("many_collection")}, ${quoteIdent(
          "many_field"
        )}`
      ].join(" ")
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

    console.log(`database=${db.path}`);
    console.log(`db_client=${db.type}`);
    console.log(`directus_collections=${collections.length}`);
    console.log(`directus_fields=${fields.length}`);
    console.log(`directus_relations=${expectedRelations.length}`);
    console.log("cms_schema=ok");
  } finally {
    await db.close();
  }
}

main().catch((error) => {
  console.error(error);
  process.exitCode = 1;
});
