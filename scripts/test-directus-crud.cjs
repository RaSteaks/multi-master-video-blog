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

async function deleteFile(token, id) {
  await request(`/files/${id}`, {
    method: "DELETE",
    token
  });
}

async function uploadTestImage(token, suffix) {
  const png = Buffer.from(
    "iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAQAAAC1HAwCAAAAC0lEQVR42mNk+A8AAQUBAScY42YAAAAASUVORK5CYII=",
    "base64"
  );
  const form = new FormData();
  form.append(
    "file",
    new Blob([png], { type: "image/png" }),
    `schema-test-photo-${suffix}.png`
  );
  form.append("title", "Schema Test Album Photo");

  const response = await fetch(`${baseUrl}/files`, {
    method: "POST",
    headers: {
      Authorization: `Bearer ${token}`
    },
    body: form
  });
  const text = await response.text();
  const data = text ? JSON.parse(text) : null;

  if (!response.ok || !data?.data?.id) {
    const message = data?.errors?.[0]?.message || text || response.statusText;
    throw new Error(`POST /files failed: ${response.status} ${message}`);
  }

  return data.data;
}

async function main() {
  const token = await login();
  const suffix = Date.now();
  const created = {};

  try {
    created.albumFile = await uploadTestImage(token, suffix);
    created.album = await createItem(token, "albums", {
      title: "Schema Test Album",
      slug: `schema-test-album-${suffix}`,
      description: "Temporary photo album validation item.",
      cover_image: created.albumFile.id,
      published: false
    });
    created.albumPhoto = await createItem(token, "album_photos", {
      album_id: created.album.id,
      sdr_image: created.albumFile.id,
      caption: "Temporary album photo.",
      alt_text: "A one-pixel schema test image.",
      published: false,
      sort_order: 10
    });
    created.albumFileTwo = await uploadTestImage(token, `${suffix}-two`);
    created.albumPhotoTwo = await createItem(token, "album_photos", {
      album_id: created.album.id,
      sdr_image: created.albumFileTwo.id,
      caption: "Earlier sorted temporary album photo.",
      alt_text: "A second one-pixel schema test image.",
      published: true,
      sort_order: 2
    });

    created.post = await createItem(token, "posts", {
      title: "Schema Test Post",
      slug: `schema-test-post-${suffix}`,
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

    const album = await request(
      `/items/albums/${created.album.id}?fields=id,title,photos.id,photos.caption`,
      { token }
    );
    const photos = album.data.photos || [];
    if (!photos.some((photo) => photo.id === created.albumPhoto.id)) {
      throw new Error("Created album photo was not returned through albums.photos relation.");
    }
    if (!photos.some((photo) => photo.id === created.albumPhotoTwo.id)) {
      throw new Error("Second album photo was not returned through albums.photos relation.");
    }

    const sortedPhotos = await request(
      `/items/album_photos?filter[album_id][_eq]=${created.album.id}&fields=id,sort_order&sort=sort_order,id`,
      { token }
    );
    if (
      sortedPhotos.data?.[0]?.id !== created.albumPhotoTwo.id ||
      sortedPhotos.data?.[1]?.id !== created.albumPhoto.id
    ) {
      throw new Error("Album photos were not returned in sort_order order.");
    }

    await deleteItem(token, "albums", created.album.id);
    created.albumDeleted = true;
    for (const photoId of [created.albumPhoto.id, created.albumPhotoTwo.id]) {
      const deletedPhoto = await request(
        `/items/album_photos?filter[id][_eq]=${photoId}&fields=id&limit=1`,
        { token }
      );
      if (deletedPhoto.data?.length) {
        throw new Error(`Album photo ${photoId} survived its parent album deletion.`);
      }
    }

    console.log(`album_created=${created.album.id}`);
    console.log(`album_photo_created=${created.albumPhoto.id}`);
    console.log(`album_photo_sorted=${created.albumPhotoTwo.id}`);
    console.log("album_photo_cascade=ok");
    console.log(`post_created=${created.post.id}`);
    console.log(`video_project_created=${created.project.id}`);
    console.log(`video_master_created=${created.master.id}`);
    console.log("cms_crud=ok");
  } finally {
    if (created.albumPhoto?.id) {
      await deleteItem(token, "album_photos", created.albumPhoto.id).catch(() => {});
    }
    if (created.albumPhotoTwo?.id) {
      await deleteItem(token, "album_photos", created.albumPhotoTwo.id).catch(() => {});
    }

    if (created.album?.id && !created.albumDeleted) {
      await deleteItem(token, "albums", created.album.id).catch(() => {});
    }

    if (created.albumFile?.id) {
      await deleteFile(token, created.albumFile.id).catch(() => {});
    }
    if (created.albumFileTwo?.id) {
      await deleteFile(token, created.albumFileTwo.id).catch(() => {});
    }

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
