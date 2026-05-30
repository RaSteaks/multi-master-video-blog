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

const env = readEnv(cmsEnvPath);
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
  const data = text ? JSON.parse(text) : null;

  if (!response.ok) {
    const message =
      typeof data === "object" && data?.errors?.[0]?.message
        ? data.errors[0].message
        : text || response.statusText;
    throw new Error(`${options.method || "GET"} ${pathname} failed: ${response.status} ${message}`);
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

async function createItem(token, collection, item) {
  const data = await request(`/items/${collection}`, {
    method: "POST",
    token,
    body: item
  });

  return data.data;
}

async function deleteItem(token, collection, id) {
  await request(`/items/${collection}/${id}`, {
    method: "DELETE",
    token
  });
}

async function main() {
  const token = await login();
  const suffix = Date.now();
  const created = {};

  try {
    created.post = await createItem(token, "posts", {
      title: "Schema Test Post",
      slug: `schema-test-post-${suffix}`,
      summary: "Temporary CRUD validation item.",
      content: "# Test\n\nTemporary content.",
      tags: ["test"],
      category: "test",
      published: false
    });

    created.project = await createItem(token, "video_projects", {
      title: "Schema Test Video",
      slug: `schema-test-video-${suffix}`,
      description: "Temporary video project validation item.",
      tags: ["test"],
      category: "test",
      published: false,
      sort_order: 0
    });

    created.master = await createItem(token, "video_masters", {
      project_id: created.project.id,
      label: "SDR Test Master",
      type: "sdr",
      hls_url: "/media/schema-test-video/sdr/master.m3u8",
      is_default: true,
      sort_order: 0,
      status: "ready"
    });

    const project = await request(
      `/items/video_projects/${created.project.id}?fields=id,title,masters.id,masters.label`,
      { token }
    );

    const masters = project.data.masters || [];
    if (!masters.some((master) => master.id === created.master.id)) {
      throw new Error("Created video master was not returned through video_projects.masters relation.");
    }

    console.log(`post_created=${created.post.id}`);
    console.log(`video_project_created=${created.project.id}`);
    console.log(`video_master_created=${created.master.id}`);
    console.log("cms_crud=ok");
  } finally {
    if (created.master?.id) {
      await deleteItem(token, "video_masters", created.master.id).catch(() => {});
    }

    if (created.project?.id) {
      await deleteItem(token, "video_projects", created.project.id).catch(() => {});
    }

    if (created.post?.id) {
      await deleteItem(token, "posts", created.post.id).catch(() => {});
    }
  }
}

main().catch((error) => {
  console.error(error);
  process.exit(1);
});
