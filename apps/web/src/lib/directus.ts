export type DirectusFileId = string | null;

export type Post = {
  id: number;
  title: string;
  slug: string;
  content: string | null;
  cover_image: DirectusFileId;
  tags: string[] | null;
  category: string | null;
  published: boolean | number;
  created_at: string | null;
  updated_at: string | null;
};

export type VideoMaster = {
  id: number;
  project_id: number;
  label: string;
  type: "sdr" | "hdr10" | "hlg" | "dolby_vision" | "custom";
  hls_url: string;
  file_url: string | null;
  codec: string | null;
  resolution_width: number | null;
  resolution_height: number | null;
  color_space: string | null;
  transfer_function: string | null;
  bit_depth: number | null;
  bitrate_mbps: number | null;
  dolby_profile: string | null;
  dolby_level: string | null;
  dolby_compatibility_id: string | null;
  dolby_rpu_present: boolean | number | null;
  dolby_el_present: boolean | number | null;
  dolby_bl_present: boolean | number | null;
  is_default: boolean | number;
  sort_order: number | null;
  status: string | null;
  uploaded_at: string | null;
  notes: string | null;
};

export type VideoProject = {
  id: number;
  title: string;
  slug: string;
  description: string | null;
  cover_image: DirectusFileId;
  category: string | null;
  tags: string[] | null;
  published: boolean | number;
  sort_order: number | null;
  created_at: string | null;
  updated_at: string | null;
  masters?: VideoMaster[];
};

type DirectusListResponse<T> = {
  data: T[];
};

type DirectusAggregateResponse = {
  data: Array<{
    count?: number | string | Record<string, number | string>;
  }>;
};

/* ---- Field sets: list views omit heavy/unused fields ---- */
const POST_LIST_FIELDS =
  "id,title,slug,summary,cover_image,category,published,created_at";
const POST_DETAIL_FIELDS =
  "id,title,slug,summary,content,cover_image,tags,category,published,created_at,updated_at";

const VIDEO_LIST_FIELDS =
  "id,title,slug,description,cover_image,poster_image,category,tags,published,sort_order,created_at," +
  "masters.id,masters.label,masters.type,masters.hls_url,masters.is_default,masters.sort_order";
const VIDEO_DETAIL_FIELDS =
  "id,title,slug,description,cover_image,poster_image,category,tags,published,sort_order,created_at,updated_at,masters.*";

/* ---- Config ---- */
let cachedToken: string | null = null;

const directusUrl = stripTrailingSlash(
  process.env.DIRECTUS_URL ||
    process.env.NEXT_PUBLIC_DIRECTUS_URL ||
    "http://127.0.0.1:8055"
);

const showDrafts = process.env.DIRECTUS_SHOW_DRAFTS === "true";

const REVALIDATE_SECONDS = process.env.DIRECTUS_REVALIDATE
  ? Number(process.env.DIRECTUS_REVALIDATE)
  : 0;

function stripTrailingSlash(value: string) {
  return value.replace(/\/$/, "");
}

function boolValue(value: boolean | number | null | undefined) {
  return value === true || value === 1;
}

function addPublishedFilter(params: URLSearchParams) {
  if (!showDrafts) {
    params.set("filter[published][_eq]", "true");
  }
}

async function getToken() {
  if (cachedToken) return cachedToken;

  const email = process.env.DIRECTUS_EMAIL;
  const password = process.env.DIRECTUS_PASSWORD;
  if (!email || !password) return null;

  const response = await fetch(`${directusUrl}/auth/login`, {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify({ email, password }),
    cache: "no-store",
  });

  if (!response.ok) {
    throw new Error(`Directus login failed: ${response.status}`);
  }

  const json = (await response.json()) as { data: { access_token: string } };
  cachedToken = json.data.access_token;
  return cachedToken;
}

async function directusFetch<T>(pathname: string, retried = false): Promise<T> {
  const token = await getToken();
  const cacheOptions =
    REVALIDATE_SECONDS > 0
      ? { next: { revalidate: REVALIDATE_SECONDS } }
      : { cache: "no-store" as const };
  const response = await fetch(`${directusUrl}${pathname}`, {
    headers: token ? { Authorization: `Bearer ${token}` } : undefined,
    ...cacheOptions,
  });

  if (response.status === 401 && token && !retried) {
    cachedToken = null;
    return directusFetch<T>(pathname, true);
  }

  if (!response.ok) {
    throw new Error(`Directus request failed: ${pathname} ${response.status}`);
  }

  return (await response.json()) as T;
}

export function assetUrl(fileId: DirectusFileId) {
  if (!fileId) return null;
  return `/api/assets/${fileId}`;
}

export function mediaUrl(pathname: string | null | undefined) {
  if (!pathname) return "";
  return pathname;
}

export function masterResolution(master: VideoMaster) {
  if (!master.resolution_width || !master.resolution_height) return null;
  return `${master.resolution_width}x${master.resolution_height}`;
}

export function isPublished(item: { published: boolean | number }) {
  return boolValue(item.published);
}

export async function getPosts(limit = 24) {
  const params = new URLSearchParams({
    fields: POST_LIST_FIELDS,
    sort: "-id",
    limit: String(limit),
  });
  addPublishedFilter(params);
  const response = await directusFetch<DirectusListResponse<Post>>(
    `/items/posts?${params.toString()}`
  );
  return response.data;
}

export async function getPost(slug: string) {
  const params = new URLSearchParams({
    fields: POST_DETAIL_FIELDS,
    "filter[slug][_eq]": slug,
    limit: "1",
  });
  addPublishedFilter(params);
  const response = await directusFetch<DirectusListResponse<Post>>(
    `/items/posts?${params.toString()}`
  );
  return response.data[0] ?? null;
}

export async function getVideoProjects(limit = 24) {
  const params = new URLSearchParams({
    fields: VIDEO_LIST_FIELDS,
    sort: "sort_order,-id",
    limit: String(limit),
  });
  addPublishedFilter(params);
  const response = await directusFetch<DirectusListResponse<VideoProject>>(
    `/items/video_projects?${params.toString()}`
  );
  return response.data.map(sortMasters);
}

export async function getVideoProject(slug: string) {
  const params = new URLSearchParams({
    fields: VIDEO_DETAIL_FIELDS,
    "filter[slug][_eq]": slug,
    limit: "1",
  });
  addPublishedFilter(params);
  const response = await directusFetch<DirectusListResponse<VideoProject>>(
    `/items/video_projects?${params.toString()}`
  );
  const project = response.data[0] ?? null;
  return project ? sortMasters(project) : null;
}

export async function getCounts() {
  const params = new URLSearchParams({ "aggregate[count]": "*" });
  addPublishedFilter(params);
  const qs = params.toString();

  const [postsRes, videosRes] = await Promise.all([
    directusFetch<DirectusAggregateResponse>(`/items/posts?${qs}`),
    directusFetch<DirectusAggregateResponse>(`/items/video_projects?${qs}`),
  ]);

  return {
    posts: aggregateCount(postsRes),
    videos: aggregateCount(videosRes),
  };
}

function aggregateCount(response: DirectusAggregateResponse) {
  const count = response.data[0]?.count;
  if (typeof count === "object" && count !== null) {
    return Number(count["*"] ?? 0);
  }

  return Number(count ?? 0);
}

function sortMasters(project: VideoProject) {
  return {
    ...project,
    masters: [...(project.masters ?? [])].sort((a, b) => {
      const orderA = a.sort_order ?? 0;
      const orderB = b.sort_order ?? 0;
      return orderA !== orderB ? orderA - orderB : a.id - b.id;
    }),
  };
}
