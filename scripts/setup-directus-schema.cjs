const fs = require("node:fs");
const path = require("node:path");
const {
  loadDirectusEnv,
  openDirectusDatabase,
  quoteIdent
} = require("./directus-db-utils.cjs");

const cmsEnvPath = path.join(
  __dirname,
  "..",
  "apps",
  "cms",
  "directus",
  ".env"
);

function readEnv(filePath) {
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

    values[trimmed.slice(0, separator)] = trimmed.slice(separator + 1);
  }

  return values;
}

const env = { ...readEnv(cmsEnvPath), ...process.env };
const baseUrl = (env.PUBLIC_URL || `http://${env.HOST || "127.0.0.1"}:${env.PORT || "8055"}`).replace(/\/$/, "");

async function request(pathname, options = {}) {
  const response = await fetch(`${baseUrl}${pathname}`, {
    ...options,
    headers: {
      "Content-Type": "application/json",
      ...(options.token ? { Authorization: `Bearer ${options.token}` } : {}),
      ...(options.headers || {})
    },
    body:
      options.body && typeof options.body !== "string"
        ? JSON.stringify(options.body)
        : options.body
  });

  const text = await response.text();
  let data = null;

  if (text) {
    try {
      data = JSON.parse(text);
    } catch {
      data = text;
    }
  }

  if (!response.ok) {
    const message =
      typeof data === "object" && data?.errors?.[0]?.message
        ? data.errors[0].message
        : text || response.statusText;
    const error = new Error(`${options.method || "GET"} ${pathname} failed: ${response.status} ${message}`);
    error.status = response.status;
    error.data = data;
    throw error;
  }

  return data;
}

async function login() {
  const data = await request("/auth/login", {
    method: "POST",
    body: {
      email: env.ADMIN_EMAIL,
      password: env.ADMIN_PASSWORD
    }
  });

  return data.data.access_token;
}

async function exists(pathname, token) {
  try {
    await request(pathname, { token });
    return true;
  } catch (error) {
    if (error.status === 404) {
      return false;
    }

    throw error;
  }
}

function isAlreadyExistsError(error) {
  const text = JSON.stringify(error.data || {}).toLowerCase();
  return (
    error.status === 400 ||
    error.status === 409 ||
    text.includes("already exists") ||
    text.includes("not unique") ||
    text.includes("unique constraint")
  );
}

async function ensureCollection(token, collection) {
  try {
    await request("/collections", {
      method: "POST",
      token,
      body: collection
    });
    console.log(`collection created: ${collection.collection}`);
  } catch (error) {
    if (isAlreadyExistsError(error)) {
      console.log(`collection exists: ${collection.collection}`);
      return;
    }

    throw error;
  }
}

async function ensureField(token, collection, field) {
  try {
    await request(`/fields/${collection}`, {
      method: "POST",
      token,
      body: field
    });
    console.log(`field created: ${collection}.${field.field}`);
  } catch (error) {
    if (isAlreadyExistsError(error)) {
      console.log(`field exists: ${collection}.${field.field}`);
      return;
    }

    throw error;
  }
}

async function ensureRelation(token, relation) {
  try {
    await request("/relations", {
      method: "POST",
      token,
      body: relation
    });
    console.log(`relation created: ${relation.collection}.${relation.field}`);
  } catch (error) {
    if (isAlreadyExistsError(error)) {
      console.log(`relation exists: ${relation.collection}.${relation.field}`);
      return;
    }

    throw error;
  }
}

async function ensureDashboard(token, dashboard) {
  const { id, ...payload } = dashboard;
  if (await exists(`/dashboards/${id}`, token)) {
    await request(`/dashboards/${id}`, {
      method: "PATCH",
      token,
      body: payload
    });
    console.log(`dashboard exists: ${dashboard.name}`);
    return;
  }

  await request("/dashboards", {
    method: "POST",
    token,
    body: dashboard
  });
  console.log(`dashboard created: ${dashboard.name}`);
}

async function ensurePanel(token, panel) {
  const { id, ...payload } = panel;
  if (await exists(`/panels/${id}`, token)) {
    await request(`/panels/${id}`, {
      method: "PATCH",
      token,
      body: payload
    });
    console.log(`panel exists: ${panel.name}`);
    return;
  }

  await request("/panels", {
    method: "POST",
    token,
    body: panel
  });
  console.log(`panel created: ${panel.name}`);
}

function stringField(field, required = false, options = {}) {
  return {
    field,
    type: "string",
    meta: {
      interface: "input",
      width: options.width || "full",
      required
    },
    schema: {
      is_nullable: !required,
      max_length: options.maxLength || 255,
      is_unique: options.unique || false
    }
  };
}

function textField(field, options = {}) {
  return {
    field,
    type: "text",
    meta: {
      interface: options.markdown ? "input-rich-text-md" : "input-multiline",
      width: "full"
    },
    schema: {
      is_nullable: true
    }
  };
}

function booleanField(field, defaultValue = false) {
  return {
    field,
    type: "boolean",
    meta: {
      interface: "boolean",
      width: "half"
    },
    schema: {
      default_value: defaultValue,
      is_nullable: false
    }
  };
}

function integerField(field, options = {}) {
  return {
    field,
    type: "integer",
    meta: {
      interface: "input",
      width: options.width || "half",
      required: options.required || false
    },
    schema: {
      is_nullable: !options.required,
      default_value: options.defaultValue ?? null
    }
  };
}

function decimalField(field) {
  return {
    field,
    type: "decimal",
    meta: {
      interface: "input",
      width: "half"
    },
    schema: {
      is_nullable: true
    }
  };
}

function dateTimeField(field) {
  return {
    field,
    type: "dateTime",
    meta: {
      interface: "datetime",
      width: "half"
    },
    schema: {
      is_nullable: true
    }
  };
}

function jsonField(field) {
  return {
    field,
    type: "json",
    meta: {
      interface: "tags",
      width: "full"
    },
    schema: {
      is_nullable: true
    }
  };
}

function colorField(field, defaultValue) {
  return {
    field,
    type: "string",
    meta: {
      interface: "select-color",
      width: "half",
      required: true,
      note: "sRGB color in #RRGGBB format.",
      validation: {
        _regex: "^#[0-9A-Fa-f]{6}$"
      },
      validation_message: "Use a six-digit sRGB value such as #7A7A7A."
    },
    schema: {
      default_value: defaultValue,
      is_nullable: false,
      max_length: 7,
      is_unique: false
    }
  };
}

function hiddenStringField(field, options = {}) {
  return {
    field,
    type: "string",
    meta: {
      interface: "input",
      hidden: true,
      width: "full"
    },
    schema: {
      is_nullable: !options.required,
      max_length: options.maxLength || 255,
      is_unique: options.unique || false
    }
  };
}

function jsonObjectField(field) {
  return {
    field,
    type: "json",
    meta: {
      interface: "input-code",
      options: {
        language: "json"
      },
      width: "full"
    },
    schema: {
      is_nullable: true
    }
  };
}

function aliasO2mField(field) {
  return {
    field,
    type: "alias",
    meta: {
      interface: "list-o2m",
      special: ["o2m"],
      options: {
        layout: "table",
        fields: ["label", "type", "hls_url", "is_default", "sort_order"]
      },
      width: "full"
    },
    schema: null
  };
}

function aliasFilesField(field) {
  return {
    field,
    type: "alias",
    meta: {
      interface: "files",
      special: ["files"],
      width: "full"
    },
    schema: null
  };
}

function hiddenJunctionField(field, type) {
  return {
    field,
    type,
    meta: {
      hidden: true,
      width: "full"
    },
    schema: {
      is_nullable: true
    }
  };
}

function fileField(field) {
  return {
    field,
    type: "uuid",
    meta: {
      interface: "file-image",
      special: ["file"],
      width: "half"
    },
    schema: {
      is_nullable: true
    }
  };
}

function selectField(field, choices, required = false) {
  return {
    field,
    type: "string",
    meta: {
      interface: "select-dropdown",
      options: {
        choices: choices.map((choice) => ({ text: choice.text, value: choice.value }))
      },
      width: "half",
      required
    },
    schema: {
      is_nullable: !required,
      max_length: 64
    }
  };
}

const collections = [
  {
    collection: "site_settings",
    meta: {
      collection: "site_settings",
      icon: "palette",
      note: "Singleton site appearance and background settings.",
      singleton: true
    },
    schema: {}
  },
  {
    collection: "site_settings_files",
    meta: {
      collection: "site_settings_files",
      icon: "import_export",
      note: "Junction records for site background images.",
      hidden: true
    },
    schema: {}
  },
  {
    collection: "posts",
    meta: {
      collection: "posts",
      icon: "article",
      note: "Blog articles and written posts.",
      display_template: "{{title}}"
    },
    schema: {}
  },
  {
    collection: "video_projects",
    meta: {
      collection: "video_projects",
      icon: "movie",
      note: "Published video entries shown on the frontend.",
      display_template: "{{title}}"
    },
    schema: {}
  },
  {
    collection: "video_masters",
    meta: {
      collection: "video_masters",
      icon: "switch_video",
      note: "Playable SDR, HDR10, HLG, Dolby Vision, or custom HLS masters.",
      display_template: "{{label}}"
    },
    schema: {}
  },
  {
    collection: "analytics_events",
    meta: {
      collection: "analytics_events",
      icon: "analytics",
      note: "Raw frontend analytics events for post views and video playback.",
      display_template: "{{event_type}} · {{item_type}} · {{created_at}}"
    },
    schema: {}
  },
  {
    collection: "analytics_items",
    meta: {
      collection: "analytics_items",
      icon: "monitoring",
      note: "Aggregated analytics counters used by the CMS dashboard.",
      display_template: "{{title}} · {{view_count}} views · {{visitor_count}} visitors"
    },
    schema: {}
  }
];

const masterTypes = [
  { text: "SDR", value: "sdr" },
  { text: "HDR10", value: "hdr10" },
  { text: "HLG", value: "hlg" },
  { text: "Dolby Vision", value: "dolby_vision" },
  { text: "Custom", value: "custom" }
];

const statusTypes = [
  { text: "Draft", value: "draft" },
  { text: "Ready", value: "ready" },
  { text: "Rejected", value: "rejected" },
  { text: "Quarantine", value: "quarantine" },
  { text: "Archived", value: "archived" }
];

const verificationStatusTypes = [
  { text: "Ready", value: "ready" },
  { text: "Rejected", value: "rejected" },
  { text: "Quarantine", value: "quarantine" }
];

const processingModeTypes = [
  { text: "Copy / Remux", value: "copy" },
  { text: "Transcode", value: "transcode" }
];

const displayGamutTypes = [
  { text: "BT.709", value: "bt709" },
  { text: "BT.2020", value: "bt2020" },
  { text: "P3-D65(smpte432)", value: "p3_d65" },
  { text: "DCI-P3(smpte431)", value: "dci_p3" },
  { text: "Custom", value: "custom" }
];

const analyticsItemTypes = [
  { text: "Post", value: "post" },
  { text: "Video", value: "video" }
];

const analyticsEventTypes = [
  { text: "View", value: "view" },
  { text: "Play", value: "play" }
];

const fields = {
  site_settings: [
    fileField("background_image"),
    integerField("background_blur", { defaultValue: 8 }),
    colorField("accent_color", "#7A7A7A"),
    aliasFilesField("background_images")
  ],
  site_settings_files: [
    hiddenJunctionField("site_settings_id", "integer"),
    hiddenJunctionField("directus_files_id", "uuid")
  ],
  posts: [
    stringField("title", true),
    stringField("slug", true, { unique: true }),
    textField("content", { markdown: true }),
    fileField("cover_image"),
    fileField("backgroundimage"),
    jsonField("tags"),
    stringField("category", false, { width: "half" }),
    booleanField("published", false),
    dateTimeField("created_at"),
    dateTimeField("updated_at")
  ],
  video_projects: [
    stringField("title", true),
    stringField("slug", true, { unique: true }),
    textField("description"),
    fileField("cover_image"),
    stringField("category", false, { width: "half" }),
    jsonField("tags"),
    booleanField("published", false),
    integerField("sort_order", { defaultValue: 0 }),
    dateTimeField("created_at"),
    dateTimeField("updated_at"),
    aliasO2mField("masters")
  ],
  video_masters: [
    integerField("project_id", { required: true }),
    stringField("label", true, { width: "half" }),
    selectField("type", masterTypes, true),
    stringField("hls_url", true),
    stringField("file_url"),
    stringField("codec", false, { width: "half" }),
    integerField("resolution_width"),
    integerField("resolution_height"),
    stringField("color_space", false, { width: "half" }),
    stringField("transfer_function", false, { width: "half" }),
    integerField("bit_depth"),
    decimalField("bitrate_mbps"),
    stringField("dolby_profile", false, { width: "half" }),
    stringField("dolby_level", false, { width: "half" }),
    stringField("dolby_compatibility_id", false, { width: "half" }),
    booleanField("dolby_rpu_present", false),
    booleanField("dolby_el_present", false),
    booleanField("dolby_bl_present", false),
    booleanField("is_default", false),
    integerField("sort_order", { defaultValue: 0 }),
    selectField("status", statusTypes, false),
    selectField("processing_mode", processingModeTypes, false),
    booleanField("is_derivative", false),
    integerField("derived_from_master_id"),
    stringField("source_sha256", false, { width: "full", maxLength: 64 }),
    selectField("display_gamut", displayGamutTypes, false),
    stringField("color_primaries", false, { width: "half" }),
    stringField("color_transfer", false, { width: "half" }),
    stringField("matrix_coefficients", false, { width: "half" }),
    stringField("color_range", false, { width: "half" }),
    stringField("pixel_format", false, { width: "half" }),
    stringField("chroma_location", false, { width: "half" }),
    stringField("hls_video_range", false, { width: "half" }),
    jsonObjectField("hdr_static_metadata"),
    jsonObjectField("dolby_metadata"),
    jsonObjectField("source_probe_json"),
    jsonObjectField("output_probe_json"),
    selectField("verification_status", verificationStatusTypes, false),
    jsonObjectField("verification_errors"),
    dateTimeField("verified_at"),
    textField("conversion_intent"),
    textField("conversion_lut_or_filter"),
    dateTimeField("uploaded_at"),
    textField("notes"),
    dateTimeField("created_at"),
    dateTimeField("updated_at")
  ],
  analytics_events: [
    selectField("event_type", analyticsEventTypes, true),
    selectField("item_type", analyticsItemTypes, true),
    stringField("item_key", true, { width: "half", maxLength: 80 }),
    integerField("post_id"),
    integerField("video_project_id"),
    integerField("video_master_id"),
    hiddenStringField("visitor_hash", { required: true, maxLength: 64 }),
    stringField("path", false, { width: "full", maxLength: 500 }),
    stringField("referrer", false, { width: "full", maxLength: 500 }),
    hiddenStringField("user_agent", { maxLength: 500 }),
    dateTimeField("created_at")
  ],
  analytics_items: [
    selectField("item_type", analyticsItemTypes, true),
    stringField("item_key", true, { width: "half", maxLength: 80, unique: true }),
    stringField("title", true, { width: "full" }),
    stringField("slug", false, { width: "half" }),
    integerField("post_id"),
    integerField("video_project_id"),
    integerField("view_count", { defaultValue: 0 }),
    integerField("visitor_count", { defaultValue: 0 }),
    integerField("play_count", { defaultValue: 0 }),
    integerField("player_count", { defaultValue: 0 }),
    dateTimeField("last_event_at"),
    dateTimeField("updated_at")
  ]
};

function fileRelation(collection, field) {
  return {
    collection,
    field,
    related_collection: "directus_files",
    meta: {
      many_collection: collection,
      many_field: field,
      one_collection: "directus_files",
      one_field: null,
      one_deselect_action: "nullify"
    },
    schema: {
      table: collection,
      column: field,
      foreign_key_table: "directus_files",
      foreign_key_column: "id",
      on_update: "NO ACTION",
      on_delete: "SET NULL"
    }
  };
}

function itemRelation(collection, field, relatedCollection) {
  return {
    collection,
    field,
    related_collection: relatedCollection,
    meta: {
      many_collection: collection,
      many_field: field,
      one_collection: relatedCollection,
      one_field: null,
      one_deselect_action: "nullify"
    },
    schema: {
      table: collection,
      column: field,
      foreign_key_table: relatedCollection,
      foreign_key_column: "id",
      on_update: "NO ACTION",
      on_delete: "SET NULL"
    }
  };
}

const relations = [
  fileRelation("site_settings", "background_image"),
  {
    collection: "site_settings_files",
    field: "directus_files_id",
    related_collection: "directus_files",
    meta: {
      many_collection: "site_settings_files",
      many_field: "directus_files_id",
      one_collection: "directus_files",
      one_field: null,
      one_deselect_action: "nullify",
      junction_field: "site_settings_id"
    },
    schema: {
      table: "site_settings_files",
      column: "directus_files_id",
      foreign_key_table: "directus_files",
      foreign_key_column: "id",
      on_update: "NO ACTION",
      on_delete: "SET NULL"
    }
  },
  {
    collection: "site_settings_files",
    field: "site_settings_id",
    related_collection: "site_settings",
    meta: {
      many_collection: "site_settings_files",
      many_field: "site_settings_id",
      one_collection: "site_settings",
      one_field: "background_images",
      one_deselect_action: "nullify",
      junction_field: "directus_files_id"
    },
    schema: {
      table: "site_settings_files",
      column: "site_settings_id",
      foreign_key_table: "site_settings",
      foreign_key_column: "id",
      on_update: "NO ACTION",
      on_delete: "SET NULL"
    }
  },
  fileRelation("posts", "cover_image"),
  fileRelation("posts", "backgroundimage"),
  fileRelation("video_projects", "cover_image"),
  itemRelation("analytics_events", "post_id", "posts"),
  itemRelation("analytics_events", "video_project_id", "video_projects"),
  itemRelation("analytics_events", "video_master_id", "video_masters"),
  itemRelation("analytics_items", "post_id", "posts"),
  itemRelation("analytics_items", "video_project_id", "video_projects"),
  {
    collection: "video_masters",
    field: "project_id",
    related_collection: "video_projects",
    meta: {
      many_collection: "video_masters",
      many_field: "project_id",
      one_collection: "video_projects",
      one_field: "masters",
      one_deselect_action: "delete"
    },
    schema: {
      table: "video_masters",
      column: "project_id",
      foreign_key_table: "video_projects",
      foreign_key_column: "id",
      on_update: "NO ACTION",
      on_delete: "CASCADE"
    }
  }
];

const analyticsDashboard = {
  id: "1d9e17dc-2d50-4606-9331-c5fb6b12d458",
  name: "Content Analytics",
  icon: "monitoring",
  color: "#5fa8d3",
  note: "Post visits, unique visitors, video visits, and playback counts."
};

const analyticsPanels = [
  {
    id: "c14e9d58-36a6-4a58-a48c-7a7e7f981b7d",
    dashboard: analyticsDashboard.id,
    name: "Top Posts",
    icon: "article",
    color: "#5fa8d3",
    show_header: true,
    type: "list",
    position_x: 1,
    position_y: 1,
    width: 18,
    height: 12,
    options: {
      collection: "analytics_items",
      limit: 20,
      sortField: "view_count",
      sortDirection: "desc",
      displayTemplate: "{{title}} · {{view_count}} views · {{visitor_count}} visitors",
      filter: { item_type: { _eq: "post" } }
    }
  },
  {
    id: "b38f82e5-cb72-4c39-b9d2-b7cae5cf4492",
    dashboard: analyticsDashboard.id,
    name: "Top Videos",
    icon: "movie",
    color: "#42b883",
    show_header: true,
    type: "list",
    position_x: 19,
    position_y: 1,
    width: 18,
    height: 12,
    options: {
      collection: "analytics_items",
      limit: 20,
      sortField: "play_count",
      sortDirection: "desc",
      displayTemplate: "{{title}} · {{play_count}} plays · {{player_count}} players · {{visitor_count}} visitors",
      filter: { item_type: { _eq: "video" } }
    }
  },
  {
    id: "b4f2651d-59dd-45b8-85ea-8f6dd23a153b",
    dashboard: analyticsDashboard.id,
    name: "Raw Events",
    icon: "timeline",
    color: "#d49b37",
    show_header: true,
    type: "time_series",
    position_x: 1,
    position_y: 13,
    width: 36,
    height: 10,
    options: {
      collection: "analytics_events",
      dateField: "created_at",
      groupAggregation: "count",
      groupPrecision: "day",
      valueField: "id",
      curveType: "smooth",
      fillType: "gradient",
      color: "#5fa8d3"
    }
  }
];

async function ensureAnalyticsDashboardInDatabase() {
  const db = await openDirectusDatabase(loadDirectusEnv());

  try {
    const panelIds = analyticsPanels.map((panel) => panel.id);
    await execDb(
      db,
      `delete from ${db.tableRef("directus_panels")} where ${quoteIdent("id")} in (${placeholders(db, panelIds.length)})`,
      panelIds
    );
    await execDb(
      db,
      `delete from ${db.tableRef("directus_dashboards")} where ${quoteIdent("id")} = ${placeholder(db, 1)}`,
      [analyticsDashboard.id]
    );
    await execDb(
      db,
      [
        `insert into ${db.tableRef("directus_dashboards")}`,
        `(${[
          "id",
          "name",
          "icon",
          "note",
          "color"
        ].map(quoteIdent).join(", ")})`,
        `values (${placeholders(db, 5)})`
      ].join(" "),
      [
        analyticsDashboard.id,
        analyticsDashboard.name,
        analyticsDashboard.icon,
        analyticsDashboard.note,
        analyticsDashboard.color
      ]
    );

    for (const panel of analyticsPanels) {
      await execDb(
        db,
        [
          `insert into ${db.tableRef("directus_panels")}`,
          `(${[
            "id",
            "dashboard",
            "name",
            "icon",
            "color",
            "show_header",
            "note",
            "type",
            "position_x",
            "position_y",
            "width",
            "height",
            "options"
          ].map(quoteIdent).join(", ")})`,
          `values (${placeholders(db, 13)})`
        ].join(" "),
        [
          panel.id,
          panel.dashboard,
          panel.name,
          panel.icon,
          panel.color,
          db.type === "pg" ? panel.show_header : Number(panel.show_header),
          panel.note || null,
          panel.type,
          panel.position_x,
          panel.position_y,
          panel.width,
          panel.height,
          JSON.stringify(panel.options)
        ]
      );
    }

    console.log(`dashboard ready: ${analyticsDashboard.name}`);
  } finally {
    await db.close();
  }
}

async function execDb(db, sql, params = []) {
  await db.all(sql, params);
}

async function ensureSiteSettingsAccentDefault(token) {
  const response = await request(
    "/items/site_settings?fields=id,accent_color",
    { token }
  );
  const settings = response?.data;

  if (
    settings &&
    (settings.accent_color == null ||
      String(settings.accent_color).trim() === "")
  ) {
    await request("/items/site_settings", {
      method: "PATCH",
      token,
      body: { accent_color: "#7A7A7A" }
    });
    console.log("site_settings.accent_color default backfilled");
  }
}

function permissionFields(value) {
  if (Array.isArray(value)) {
    return value.map(String);
  }

  if (typeof value === "string") {
    return value
      .split(",")
      .map((field) => field.trim())
      .filter(Boolean);
  }

  return [];
}

async function ensurePublicReadPermission(
  token,
  publicPolicyId,
  collection,
  requiredFields
) {
  const permissionQuery = new URLSearchParams({
    "filter[collection][_eq]": collection,
    "filter[action][_eq]": "read",
    "filter[policy][_eq]": publicPolicyId,
    fields: "id,fields",
    limit: "1"
  });
  const permissions = await request(`/permissions?${permissionQuery}`, {
    token
  });
  const permission = permissions?.data?.[0];

  if (!permission) {
    await request("/permissions", {
      method: "POST",
      token,
      body: {
        collection,
        action: "read",
        permissions: {},
        validation: {},
        presets: null,
        fields: requiredFields,
        policy: publicPolicyId
      }
    });
    console.log(`public permission created: ${collection}.read`);
    return;
  }

  const currentFields = permissionFields(permission.fields);
  if (currentFields.includes("*")) {
    console.log(`public permission exists: ${collection}.read fields=*`);
    return;
  }

  const mergedFields = [...new Set([...currentFields, ...requiredFields])];
  await request(`/permissions/${permission.id}`, {
    method: "PATCH",
    token,
    body: { fields: mergedFields }
  });
  console.log(
    `public permission ready: ${collection}.read fields=${mergedFields.join(",")}`
  );
}

async function ensurePublicSiteSettingsPermission(token) {
  const policyQuery = new URLSearchParams({
    "filter[name][_eq]": "$t:public_label",
    fields: "id",
    limit: "1"
  });
  const policies = await request(`/policies?${policyQuery}`, { token });
  const publicPolicyId = policies?.data?.[0]?.id;

  if (!publicPolicyId) {
    throw new Error("Directus public policy was not found.");
  }

  await ensurePublicReadPermission(
    token,
    publicPolicyId,
    "site_settings",
    [
      "background_image",
      "background_blur",
      "background_images",
      "accent_color"
    ]
  );
  await ensurePublicReadPermission(
    token,
    publicPolicyId,
    "site_settings_files",
    ["site_settings_id", "directus_files_id"]
  );
}

function placeholder(db, index) {
  return db.type === "pg" ? `$${index}` : "?";
}

function placeholders(db, count) {
  return Array.from({ length: count }, (_, index) => placeholder(db, index + 1)).join(", ");
}

async function main() {
  const token = await login();

  for (const collection of collections) {
    await ensureCollection(token, collection);
  }

  for (const [collection, collectionFields] of Object.entries(fields)) {
    for (const field of collectionFields) {
      await ensureField(token, collection, field);
    }
  }

  for (const relation of relations) {
    await ensureRelation(token, relation);
  }

  await ensureSiteSettingsAccentDefault(token);
  await ensurePublicSiteSettingsPermission(token);
  await ensureAnalyticsDashboardInDatabase();

  console.log("Directus content schema is ready.");
}

main().catch((error) => {
  console.error(error);
  process.exit(1);
});
