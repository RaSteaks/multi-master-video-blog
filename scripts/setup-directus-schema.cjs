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

function bigIntegerField(field, options = {}) {
  return {
    field,
    type: "bigInteger",
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

function aliasO2mField(field, displayFields = ["label", "type", "hls_url", "is_default", "sort_order"]) {
  return {
    field,
    type: "alias",
    meta: {
      interface: "list-o2m",
      special: ["o2m"],
      options: {
        layout: "table",
        fields: displayFields
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

function fileField(field, options = {}) {
  return {
    field,
    type: "uuid",
    meta: {
      interface: "file-image",
      special: ["file"],
      width: options.width || "half",
      required: options.required || false
    },
    schema: {
      is_nullable: !options.required
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
    collection: "albums",
    meta: {
      collection: "albums",
      icon: "photo_library",
      note: "Published photo albums shown on the frontend.",
      display_template: "{{title}}"
    },
    schema: {}
  },
  {
    collection: "album_photos",
    meta: {
      collection: "album_photos",
      icon: "photo",
      note: "SDR photos with an optional paired HDR AVIF rendition.",
      display_template: "{{caption}}"
    },
    schema: {}
  },
  {
    collection: "film_scan_jobs",
    meta: {
      collection: "film_scan_jobs",
      icon: "scanner",
      note: "Recoverable film-scan analysis, review, and rendering jobs.",
      display_template: "{{film_stock}} · {{scanner}} · {{status}}"
    },
    schema: {}
  },
  {
    collection: "film_scan_sources",
    meta: {
      collection: "film_scan_sources",
      icon: "draft",
      note: "Private original film-scan sources retained for reproducible rendering.",
      display_template: "{{original_name}} · {{decode_status}}"
    },
    schema: {}
  },
  {
    collection: "film_scan_frames",
    meta: {
      collection: "film_scan_frames",
      icon: "crop",
      note: "Detected or manually adjusted frames within film-scan sources.",
      display_template: "#{{sort_order}} · {{review_status}}"
    },
    schema: {}
  },
  {
    collection: "film_stock_presets",
    meta: {
      collection: "film_stock_presets",
      icon: "tune",
      note: "Built-in and custom film-base and color presets.",
      display_template: "{{manufacturer}} {{model}}"
    },
    schema: {}
  },
  {
    collection: "album_photo_renditions",
    meta: {
      collection: "album_photo_renditions",
      icon: "hdr_on",
      note: "SDR, PQ, and HLG files generated for an album photo.",
      display_template: "{{kind}} · {{bit_depth}}-bit"
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

const photoHdrTransferTypes = [
  { text: "PQ (ST 2084)", value: "pq" },
  { text: "HLG (ARIB STD-B67)", value: "hlg" }
];

const filmScanStatusTypes = [
  { text: "Uploaded", value: "uploaded" },
  { text: "Analyzing", value: "analyzing" },
  { text: "Review required", value: "review_required" },
  { text: "Rendering", value: "rendering" },
  { text: "Committed", value: "committed" },
  { text: "Failed", value: "failed" },
  { text: "Canceled", value: "canceled" }
];

const filmScannerTypes = [
  { text: "Hasselblad X5 (experimental)", value: "hasselblad-x5" },
  { text: "Fujifilm SP-3000 (experimental)", value: "fujifilm-sp3000" },
  { text: "Noritsu HS-1800 (experimental)", value: "noritsu-hs1800" }
];

const filmFrameFormatTypes = [
  { text: "135 full frame", value: "135-full" },
  { text: "135 half frame", value: "135-half" },
  { text: "135 panoramic", value: "135-pano" },
  { text: "120 6×4.5", value: "120-645" },
  { text: "120 6×6", value: "120-66" },
  { text: "120 6×7", value: "120-67" },
  { text: "120 6×8", value: "120-68" },
  { text: "120 6×9", value: "120-69" }
];

const filmTypeChoices = [
  { text: "Color negative", value: "color-negative" },
  { text: "Black-and-white negative", value: "bw-negative" },
  { text: "E-6 slide / positive", value: "slide" }
];

const filmProcessChoices = [
  { text: "C-41", value: "c41" },
  { text: "E-6", value: "e6" },
  { text: "ECN-2", value: "ecn2" },
  { text: "Black and white", value: "bw" },
  { text: "Other", value: "other" }
];

const renditionKinds = [
  { text: "SDR", value: "sdr" },
  { text: "PQ", value: "pq" },
  { text: "HLG", value: "hlg" }
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
  albums: [
    stringField("title", true, { maxLength: 200 }),
    stringField("slug", true, { unique: true, maxLength: 200 }),
    textField("description"),
    fileField("cover_image"),
    booleanField("published", true),
    dateTimeField("created_at"),
    dateTimeField("updated_at"),
    aliasO2mField("photos", [
      "sdr_image",
      "hdr_image",
      "caption",
      "published",
      "sort_order"
    ]),
    aliasO2mField("film_scan_jobs", ["film_stock", "scanner", "status", "progress"])
  ],
  album_photos: [
    integerField("album_id", { required: true }),
    fileField("sdr_image", { required: true }),
    fileField("hdr_image"),
    textField("caption"),
    stringField("alt_text", false, { width: "full", maxLength: 500 }),
    selectField("hdr_transfer", photoHdrTransferTypes, false),
    stringField("hdr_primaries", false, { width: "half", maxLength: 64 }),
    integerField("hdr_bit_depth"),
    integerField("film_scan_frame_id"),
    stringField("film_stock", false, { width: "half", maxLength: 160 }),
    stringField("film_process", false, { width: "half", maxLength: 64 }),
    stringField("film_scanner", false, { width: "half", maxLength: 64 }),
    stringField("film_frame_format", false, { width: "half", maxLength: 64 }),
    booleanField("published", false),
    integerField("sort_order", { defaultValue: 0 }),
    dateTimeField("created_at"),
    dateTimeField("updated_at"),
    aliasO2mField("renditions", [
      "kind",
      "file",
      "transfer",
      "primaries",
      "bit_depth",
      "is_default"
    ])
  ],
  film_scan_jobs: [
    integerField("album_id", { required: true }),
    selectField("status", filmScanStatusTypes, true),
    selectField("scanner", filmScannerTypes, true),
    selectField("frame_format", filmFrameFormatTypes, true),
    selectField("film_type", filmTypeChoices, true),
    stringField("film_stock", true, { width: "half", maxLength: 160 }),
    integerField("iso", { required: true }),
    selectField("process", filmProcessChoices, true),
    decimalField("push_pull"),
    jsonObjectField("roll_adjustments"),
    integerField("progress", { defaultValue: 0 }),
    jsonObjectField("warnings"),
    textField("error_message"),
    booleanField("experimental_compatibility", true),
    dateTimeField("started_at"),
    dateTimeField("completed_at"),
    dateTimeField("created_at"),
    dateTimeField("updated_at"),
    aliasO2mField("sources", [
      "original_name",
      "format",
      "bit_depth",
      "decode_status"
    ]),
    aliasO2mField("frames", [
      "sort_order",
      "confidence",
      "review_status",
      "preview_path"
    ])
  ],
  film_scan_sources: [
    integerField("job_id", { required: true }),
    stringField("original_name", true, { maxLength: 255 }),
    stringField("relative_path", true, { maxLength: 500 }),
    stringField("format", true, { width: "half", maxLength: 32 }),
    stringField("mime_type", true, { width: "half", maxLength: 64 }),
    bigIntegerField("size_bytes"),
    stringField("sha256", true, { width: "full", maxLength: 64 }),
    integerField("width"),
    integerField("height"),
    integerField("bit_depth"),
    stringField("icc_description", false, { width: "half", maxLength: 255 }),
    booleanField("has_icc", false),
    stringField("decode_status", true, { width: "half", maxLength: 32 }),
    textField("decode_error"),
    dateTimeField("created_at"),
    dateTimeField("updated_at")
  ],
  film_scan_frames: [
    integerField("job_id", { required: true }),
    integerField("source_id", { required: true }),
    integerField("album_photo_id"),
    decimalField("crop_x"),
    decimalField("crop_y"),
    decimalField("crop_width"),
    decimalField("crop_height"),
    integerField("rotation", { defaultValue: 0 }),
    integerField("sort_order", { defaultValue: 0 }),
    decimalField("confidence"),
    stringField("review_status", true, { width: "half", maxLength: 32 }),
    booleanField("accepted", true),
    booleanField("published", true),
    jsonObjectField("adjustment_overrides"),
    stringField("preview_path", false, { maxLength: 500 }),
    dateTimeField("created_at"),
    dateTimeField("updated_at")
  ],
  film_stock_presets: [
    stringField("manufacturer", true, { width: "half", maxLength: 100 }),
    stringField("model", true, { width: "half", maxLength: 160 }),
    selectField("film_type", filmTypeChoices, true),
    integerField("nominal_iso"),
    selectField("recommended_process", filmProcessChoices, false),
    selectField("scanner", filmScannerTypes, false),
    jsonObjectField("parameters"),
    booleanField("built_in", false),
    dateTimeField("created_at"),
    dateTimeField("updated_at")
  ],
  album_photo_renditions: [
    integerField("photo_id", { required: true }),
    integerField("film_scan_frame_id"),
    selectField("kind", renditionKinds, true),
    fileField("file", { required: true }),
    stringField("transfer", false, { width: "half", maxLength: 64 }),
    stringField("primaries", false, { width: "half", maxLength: 64 }),
    integerField("bit_depth"),
    booleanField("is_default", false),
    dateTimeField("created_at")
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

function fileRelation(collection, field, options = {}) {
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
      on_delete: options.onDelete || "SET NULL"
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
  fileRelation("albums", "cover_image"),
  fileRelation("album_photos", "sdr_image", { onDelete: "RESTRICT" }),
  fileRelation("album_photos", "hdr_image"),
  fileRelation("album_photo_renditions", "file", { onDelete: "RESTRICT" }),
  {
    collection: "film_scan_jobs",
    field: "album_id",
    related_collection: "albums",
    meta: {
      many_collection: "film_scan_jobs",
      many_field: "album_id",
      one_collection: "albums",
      one_field: "film_scan_jobs",
      one_deselect_action: "delete"
    },
    schema: {
      table: "film_scan_jobs",
      column: "album_id",
      foreign_key_table: "albums",
      foreign_key_column: "id",
      on_update: "NO ACTION",
      on_delete: "CASCADE"
    }
  },
  {
    collection: "film_scan_sources",
    field: "job_id",
    related_collection: "film_scan_jobs",
    meta: {
      many_collection: "film_scan_sources",
      many_field: "job_id",
      one_collection: "film_scan_jobs",
      one_field: "sources",
      one_deselect_action: "delete"
    },
    schema: {
      table: "film_scan_sources",
      column: "job_id",
      foreign_key_table: "film_scan_jobs",
      foreign_key_column: "id",
      on_update: "NO ACTION",
      on_delete: "CASCADE"
    }
  },
  {
    collection: "film_scan_frames",
    field: "job_id",
    related_collection: "film_scan_jobs",
    meta: {
      many_collection: "film_scan_frames",
      many_field: "job_id",
      one_collection: "film_scan_jobs",
      one_field: "frames",
      one_deselect_action: "delete"
    },
    schema: {
      table: "film_scan_frames",
      column: "job_id",
      foreign_key_table: "film_scan_jobs",
      foreign_key_column: "id",
      on_update: "NO ACTION",
      on_delete: "CASCADE"
    }
  },
  itemRelation("film_scan_frames", "source_id", "film_scan_sources"),
  itemRelation("film_scan_frames", "album_photo_id", "album_photos"),
  itemRelation("album_photos", "film_scan_frame_id", "film_scan_frames"),
  {
    collection: "album_photo_renditions",
    field: "photo_id",
    related_collection: "album_photos",
    meta: {
      many_collection: "album_photo_renditions",
      many_field: "photo_id",
      one_collection: "album_photos",
      one_field: "renditions",
      one_deselect_action: "delete"
    },
    schema: {
      table: "album_photo_renditions",
      column: "photo_id",
      foreign_key_table: "album_photos",
      foreign_key_column: "id",
      on_update: "NO ACTION",
      on_delete: "CASCADE"
    }
  },
  itemRelation("album_photo_renditions", "film_scan_frame_id", "film_scan_frames"),
  itemRelation("analytics_events", "post_id", "posts"),
  itemRelation("analytics_events", "video_project_id", "video_projects"),
  itemRelation("analytics_events", "video_master_id", "video_masters"),
  itemRelation("analytics_items", "post_id", "posts"),
  itemRelation("analytics_items", "video_project_id", "video_projects"),
  {
    collection: "album_photos",
    field: "album_id",
    related_collection: "albums",
    meta: {
      many_collection: "album_photos",
      many_field: "album_id",
      one_collection: "albums",
      one_field: "photos",
      one_deselect_action: "delete"
    },
    schema: {
      table: "album_photos",
      column: "album_id",
      foreign_key_table: "albums",
      foreign_key_column: "id",
      on_update: "NO ACTION",
      on_delete: "CASCADE"
    }
  },
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

const albumAssetPresets = [
  {
    key: "album-cover",
    fit: "cover",
    width: 960,
    height: 640,
    quality: 84,
    withoutEnlargement: true,
    format: "webp"
  },
  {
    key: "album-thumb",
    fit: "contain",
    width: 720,
    height: 720,
    quality: 86,
    withoutEnlargement: true,
    format: "webp"
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

async function ensureAlbumAssetPresets(token) {
  const response = await request(
    "/settings?fields=storage_asset_transform,storage_asset_presets",
    { token }
  );
  const settings = response?.data || {};
  const currentPresets = Array.isArray(settings.storage_asset_presets)
    ? settings.storage_asset_presets
    : [];
  const managedKeys = new Set(albumAssetPresets.map((preset) => preset.key));
  const unmanagedPresets = currentPresets.filter(
    (preset) => !managedKeys.has(preset?.key)
  );
  const nextPresets = [...unmanagedPresets, ...albumAssetPresets];
  const currentManaged = currentPresets.filter((preset) =>
    managedKeys.has(preset?.key)
  );
  const presetsChanged =
    currentManaged.length !== albumAssetPresets.length ||
    albumAssetPresets.some((expected) => {
      const current = currentManaged.find((preset) => preset.key === expected.key);
      return !current || !assetPresetMatches(current, expected);
    });
  const nextTransformMode =
    settings.storage_asset_transform === "all" ? "all" : "presets";

  if (
    !presetsChanged &&
    settings.storage_asset_transform === nextTransformMode
  ) {
    console.log("album asset presets exist");
    return;
  }

  await request("/settings", {
    method: "PATCH",
    token,
    body: {
      storage_asset_transform: nextTransformMode,
      storage_asset_presets: nextPresets
    }
  });
  console.log("album asset presets ready");
}

async function ensureAlbumFieldDefaults(token) {
  await request("/fields/albums/published", {
    method: "PATCH",
    token,
    body: {
      schema: {
        default_value: true
      }
    }
  });
  console.log("album field defaults ready");
}

function assetPresetMatches(current, expected) {
  return Object.entries(expected).every(
    ([key, value]) => current?.[key] === value
  );
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
  requiredFields,
  recordPermissions = null
) {
  const permissionQuery = new URLSearchParams({
    "filter[collection][_eq]": collection,
    "filter[action][_eq]": "read",
    "filter[policy][_eq]": publicPolicyId,
    fields: "id,fields,permissions",
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
        permissions: recordPermissions || {},
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
  const mergedFields = currentFields.includes("*")
    ? ["*"]
    : [...new Set([...currentFields, ...requiredFields])];
  const patch = { fields: mergedFields };
  if (recordPermissions) patch.permissions = recordPermissions;
  await request(`/permissions/${permission.id}`, {
    method: "PATCH",
    token,
    body: patch
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
  await ensurePublicReadPermission(
    token,
    publicPolicyId,
    "albums",
    [
      "id", "title", "slug", "description", "cover_image", "published",
      "created_at", "updated_at", "photos"
    ],
    { published: { _eq: true } }
  );
  await ensurePublicReadPermission(
    token,
    publicPolicyId,
    "album_photos",
    [
      "id", "album_id", "sdr_image", "hdr_image", "caption", "alt_text",
      "hdr_transfer", "hdr_primaries", "hdr_bit_depth", "film_scan_frame_id",
      "film_stock", "film_process", "film_scanner", "film_frame_format",
      "published", "sort_order", "created_at", "updated_at", "renditions"
    ],
    {
      _and: [
        { published: { _eq: true } },
        { album_id: { published: { _eq: true } } }
      ]
    }
  );
  await ensurePublicReadPermission(
    token,
    publicPolicyId,
    "album_photo_renditions",
    [
      "id", "photo_id", "film_scan_frame_id", "kind", "file", "transfer",
      "primaries", "bit_depth", "is_default", "created_at"
    ],
    {
      photo_id: {
        published: { _eq: true },
        album_id: { published: { _eq: true } }
      }
    }
  );
}

const builtInFilmStockPresets = [
  ["Kodak", "Portra 160", "color-negative", 160, "c41", [0.83, 0.63, 0.42]],
  ["Kodak", "Portra 400", "color-negative", 400, "c41", [0.82, 0.61, 0.4]],
  ["Kodak", "Portra 800", "color-negative", 800, "c41", [0.81, 0.6, 0.39]],
  ["Kodak", "Gold 200", "color-negative", 200, "c41", [0.84, 0.62, 0.4]],
  ["Kodak", "Ektar 100", "color-negative", 100, "c41", [0.82, 0.6, 0.38]],
  ["Kodak", "5203 Vision3 50D", "color-negative", 50, "ecn2", [0.8, 0.58, 0.37]],
  [
    "Kodak",
    "5207 Vision3 250D",
    "color-negative",
    250,
    "ecn2",
    [0.8, 0.58, 0.37],
    ["Vision3 250D"]
  ],
  ["Kodak", "5219 Vision3 500T", "color-negative", 500, "ecn2", [0.8, 0.58, 0.37]],
  ["Fujifilm", "Pro 400H", "color-negative", 400, "c41", [0.79, 0.62, 0.43]],
  ["Fujifilm", "Velvia 50", "slide", 50, "e6", null],
  ["Kodak", "Tri-X 400", "bw-negative", 400, "bw", null],
  ["Ilford", "HP5 Plus", "bw-negative", 400, "bw", null],
  ["Ilford", "Delta 100", "bw-negative", 100, "bw", null]
];

async function ensureBuiltInFilmStockPresets(token) {
  for (const [
    manufacturer,
    model,
    filmType,
    nominalIso,
    recommendedProcess,
    maskRgb,
    legacyModels = []
  ] of builtInFilmStockPresets) {
    let existing = null;
    for (const candidateModel of [model, ...legacyModels]) {
      const params = new URLSearchParams({
        "filter[manufacturer][_eq]": manufacturer,
        "filter[model][_eq]": candidateModel,
        "filter[built_in][_eq]": "true",
        fields: "id",
        limit: "1"
      });
      existing = await request(`/items/film_stock_presets?${params}`, {
        token
      });
      if (existing?.data?.[0]?.id) break;
    }
    const payload = {
      manufacturer,
      model,
      film_type: filmType,
      nominal_iso: nominalIso,
      recommended_process: recommendedProcess,
      scanner: null,
      parameters: maskRgb ? { maskRgb, maskMode: "preset" } : {},
      built_in: true,
      updated_at: new Date().toISOString()
    };
    if (existing?.data?.[0]?.id) {
      await request(`/items/film_stock_presets/${existing.data[0].id}`, {
        method: "PATCH",
        token,
        body: payload
      });
    } else {
      await request("/items/film_stock_presets", {
        method: "POST",
        token,
        body: { ...payload, created_at: new Date().toISOString() }
      });
    }
  }
  console.log(`film stock presets ready: ${builtInFilmStockPresets.length}`);
}

async function ensureFilmScanSourceSizeType(token) {
  const pathname = "/fields/film_scan_sources/size_bytes";
  const current = await request(pathname, { token });
  const currentType = current?.data?.type;
  const currentDataType = String(current?.data?.schema?.data_type || "").toLowerCase();
  if (
    currentType === "bigInteger" &&
    ["bigint", "integer", "big integer"].includes(currentDataType)
  ) {
    console.log("film_scan_sources.size_bytes type ready: bigInteger");
    return;
  }

  const { field: _field, ...sizeFieldDefinition } =
    bigIntegerField("size_bytes");
  await request(pathname, {
    method: "PATCH",
    token,
    body: sizeFieldDefinition
  });
  const updated = await request(pathname, { token });
  if (updated?.data?.type !== "bigInteger") {
    throw new Error(
      `film_scan_sources.size_bytes migration failed: ${updated?.data?.type || "unknown"}`
    );
  }
  console.log(
    `film_scan_sources.size_bytes migrated: ${currentType || "unknown"} -> bigInteger`
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

  await ensureFilmScanSourceSizeType(token);

  for (const relation of relations) {
    await ensureRelation(token, relation);
  }

  await ensureAlbumFieldDefaults(token);
  await ensureAlbumAssetPresets(token);
  await ensureBuiltInFilmStockPresets(token);
  await ensureSiteSettingsAccentDefault(token);
  await ensurePublicSiteSettingsPermission(token);
  await ensureAnalyticsDashboardInDatabase();

  console.log("Directus content schema is ready.");
}

main().catch((error) => {
  console.error(error);
  process.exit(1);
});
