const {
  loadDirectusEnv,
  openDirectusDatabase,
  quoteIdent
} = require("./directus-db-utils.cjs");

const expectedTables = {
  site_settings: [
    "id",
    "background_image",
    "background_blur",
    "accent_color"
  ],
  site_settings_files: [
    "id",
    "site_settings_id",
    "directus_files_id"
  ],
  posts: [
    "id",
    "title",
    "slug",
    "content",
    "cover_image",
    "backgroundimage",
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
  ],
  albums: [
    "id",
    "title",
    "slug",
    "description",
    "cover_image",
    "published",
    "created_at",
    "updated_at"
  ],
  album_photos: [
    "id",
    "album_id",
    "sdr_image",
    "hdr_image",
    "caption",
    "alt_text",
    "hdr_transfer",
    "hdr_primaries",
    "hdr_bit_depth",
    "published",
    "sort_order",
    "created_at",
    "updated_at"
  ],
  analytics_events: [
    "id",
    "event_type",
    "item_type",
    "item_key",
    "post_id",
    "video_project_id",
    "video_master_id",
    "visitor_hash",
    "path",
    "referrer",
    "user_agent",
    "created_at"
  ],
  analytics_items: [
    "id",
    "item_type",
    "item_key",
    "title",
    "slug",
    "post_id",
    "video_project_id",
    "view_count",
    "visitor_count",
    "play_count",
    "player_count",
    "last_event_at",
    "updated_at"
  ]
};

const expectedRelations = [
  ["site_settings", "background_image", "directus_files"],
  ["site_settings_files", "directus_files_id", "directus_files"],
  ["site_settings_files", "site_settings_id", "site_settings"],
  ["posts", "cover_image", "directus_files"],
  ["posts", "backgroundimage", "directus_files"],
  ["video_projects", "cover_image", "directus_files"],
  ["albums", "cover_image", "directus_files"],
  ["album_photos", "sdr_image", "directus_files"],
  ["album_photos", "hdr_image", "directus_files"],
  ["album_photos", "album_id", "albums"],
  ["video_masters", "project_id", "video_projects"],
  ["analytics_events", "post_id", "posts"],
  ["analytics_events", "video_project_id", "video_projects"],
  ["analytics_events", "video_master_id", "video_masters"],
  ["analytics_items", "post_id", "posts"],
  ["analytics_items", "video_project_id", "video_projects"]
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
        `where ${quoteIdent("collection")} in (${collectionPlaceholders(db.type)})`,
        `order by ${quoteIdent("collection")}`
      ].join(" "),
      Object.keys(expectedTables)
    );
    const fields = await db.all(
      [
        "select",
        `${quoteIdent("collection")}, ${quoteIdent("field")}, ${quoteIdent(
          "special"
        )}`,
        `from ${db.tableRef("directus_fields")}`,
        `where ${quoteIdent("collection")} in (${collectionPlaceholders(db.type)})`,
        `order by ${quoteIdent("collection")}, ${quoteIdent("field")}`
      ].join(" "),
      Object.keys(expectedTables)
    );
    const relations = await db.all(
      [
        "select",
        `${quoteIdent("many_collection")}, ${quoteIdent(
          "many_field"
        )}, ${quoteIdent("one_collection")}, ${quoteIdent(
          "one_field"
        )}, ${quoteIdent("junction_field")}`,
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

    if (
      !fields.some(
        (field) => field.collection === "albums" && field.field === "photos"
      )
    ) {
      throw new Error("Missing Directus alias field: albums.photos");
    }

    const albumPhotosRelation = relations.find(
      (relation) =>
        relation.many_collection === "album_photos" &&
        relation.many_field === "album_id"
    );
    if (albumPhotosRelation?.one_field !== "photos") {
      throw new Error("Invalid Directus O2M relation metadata for albums.photos");
    }

    const backgroundImagesField = fields.find(
      (field) =>
        field.collection === "site_settings" &&
        field.field === "background_images"
    );
    if (
      !backgroundImagesField ||
      !String(backgroundImagesField.special || "")
        .split(",")
        .map((value) => value.trim())
        .includes("files")
    ) {
      throw new Error(
        "Missing Directus files alias field: site_settings.background_images"
      );
    }

    const siteSettingsFilesRelation = relations.find(
      (relation) =>
        relation.many_collection === "site_settings_files" &&
        relation.many_field === "site_settings_id"
    );
    const directusFilesRelation = relations.find(
      (relation) =>
        relation.many_collection === "site_settings_files" &&
        relation.many_field === "directus_files_id"
    );
    if (
      siteSettingsFilesRelation?.one_field !== "background_images" ||
      siteSettingsFilesRelation?.junction_field !== "directus_files_id" ||
      directusFilesRelation?.junction_field !== "site_settings_id"
    ) {
      throw new Error(
        "Invalid Directus M2M relation metadata for site_settings.background_images"
      );
    }

    const publicPolicy = await db.get(
      [
        "select",
        quoteIdent("id"),
        `from ${db.tableRef("directus_policies")}`,
        `where ${quoteIdent("name")} = ${db.type === "pg" ? "$1" : "?"}`
      ].join(" "),
      ["$t:public_label"]
    );

    if (!publicPolicy) {
      throw new Error("Missing Directus public policy");
    }

    const publicPermissions = await db.all(
      [
        "select",
        `${quoteIdent("collection")}, ${quoteIdent("fields")}`,
        `from ${db.tableRef("directus_permissions")}`,
        `where ${quoteIdent("action")} = ${db.type === "pg" ? "$1" : "?"}`,
        `and ${quoteIdent("policy")} = ${db.type === "pg" ? "$2" : "?"}`
      ].join(" "),
      ["read", publicPolicy.id]
    );

    const publicSitePermission = publicPermissions.find(
      (permission) => permission.collection === "site_settings"
    );
    const publicSiteSettingsFilesPermission = publicPermissions.find(
      (permission) => permission.collection === "site_settings_files"
    );
    const publicFields = permissionFields(publicSitePermission?.fields);
    const publicJunctionFields = permissionFields(
      publicSiteSettingsFilesPermission?.fields
    );
    if (
      !publicSitePermission ||
      (!publicFields.includes("*") &&
        (!publicFields.includes("accent_color") ||
          !publicFields.includes("background_images")))
    ) {
      throw new Error(
        "Public site_settings.read permission is missing appearance fields"
      );
    }
    if (
      !publicSiteSettingsFilesPermission ||
      (!publicJunctionFields.includes("*") &&
        (!publicJunctionFields.includes("site_settings_id") ||
          !publicJunctionFields.includes("directus_files_id")))
    ) {
      throw new Error(
        "Public site_settings_files.read permission is missing junction fields"
      );
    }

    const directusSettings = await db.get(
      [
        "select",
        `${quoteIdent("storage_asset_transform")}, ${quoteIdent(
          "storage_asset_presets"
        )}`,
        `from ${db.tableRef("directus_settings")}`,
        "limit 1"
      ].join(" ")
    );
    const assetPresets = jsonArray(directusSettings?.storage_asset_presets);
    for (const key of ["album-cover", "album-thumb"]) {
      if (!assetPresets.some((preset) => preset?.key === key)) {
        throw new Error(`Missing Directus asset preset: ${key}`);
      }
    }
    if (!["all", "presets"].includes(directusSettings?.storage_asset_transform)) {
      throw new Error("Directus asset transformations are not enabled");
    }

    const albumPublishedDefault =
      db.type === "pg"
        ? await db.get(
            [
              "select column_default",
              "from information_schema.columns",
              "where table_schema = $1 and table_name = $2 and column_name = $3"
            ].join(" "),
            [db.schema, "albums", "published"]
          )
        : await db.get(
            "select dflt_value as column_default from pragma_table_info('albums') where name = ?",
            ["published"]
          );
    if (!/^(?:true|1)$/i.test(String(albumPublishedDefault?.column_default))) {
      throw new Error("albums.published does not default to true");
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

function collectionPlaceholders(dbType) {
  return Object.keys(expectedTables)
    .map((_, index) => (dbType === "pg" ? `$${index + 1}` : "?"))
    .join(", ");
}

function permissionFields(value) {
  if (Array.isArray(value)) {
    return value.map(String);
  }

  return String(value || "")
    .split(",")
    .map((field) => field.trim())
    .filter(Boolean);
}

function jsonArray(value) {
  if (Array.isArray(value)) {
    return value;
  }

  if (typeof value === "string" && value) {
    try {
      const parsed = JSON.parse(value);
      return Array.isArray(parsed) ? parsed : [];
    } catch {
      return [];
    }
  }

  return [];
}
