const fs = require("node:fs");
const path = require("node:path");

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
  { text: "Archived", value: "archived" }
];

const fields = {
  posts: [
    stringField("title", true),
    stringField("slug", true, { unique: true }),
    textField("content", { markdown: true }),
    fileField("cover_image"),
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
    dateTimeField("uploaded_at"),
    textField("notes"),
    dateTimeField("created_at"),
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

const relations = [
  fileRelation("posts", "cover_image"),
  fileRelation("video_projects", "cover_image"),
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

  console.log("Directus content schema is ready.");
}

main().catch((error) => {
  console.error(error);
  process.exit(1);
});
