export type DirectusFileId = string | null;
export type AlbumAssetPreset = "album-cover" | "album-thumb";

export type Post = {
  id: number;
  title: string;
  slug: string;
  content: string | null;
  cover_image: DirectusFileId;
  backgroundimage: DirectusFileId;
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
  processing_mode: "copy" | "transcode" | string | null;
  is_derivative: boolean | number | null;
  derived_from_master_id: number | null;
  source_sha256: string | null;
  display_gamut: "bt709" | "bt2020" | "p3_d65" | "dci_p3" | "custom" | string | null;
  color_primaries: string | null;
  color_transfer: string | null;
  matrix_coefficients: string | null;
  color_range: string | null;
  pixel_format: string | null;
  chroma_location: string | null;
  hls_video_range: "SDR" | "PQ" | "HLG" | string | null;
  hdr_static_metadata: Record<string, unknown> | null;
  dolby_metadata: Record<string, unknown> | null;
  source_probe_json: Record<string, unknown> | null;
  output_probe_json: Record<string, unknown> | null;
  verification_status: "ready" | "rejected" | "quarantine" | string | null;
  verification_errors: unknown[] | Record<string, unknown> | null;
  verified_at: string | null;
  conversion_intent: string | null;
  conversion_lut_or_filter: string | null;
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

export type AlbumPhoto = {
  id: number;
  album_id: number | { id: number };
  sdr_image: DirectusFileId;
  hdr_image: DirectusFileId;
  caption: string | null;
  alt_text: string | null;
  hdr_transfer: "pq" | "hlg" | null;
  hdr_primaries: string | null;
  hdr_bit_depth: number | null;
  film_scan_frame_id: number | { id: number } | null;
  film_stock: string | null;
  film_process: string | null;
  film_scanner: string | null;
  film_frame_format: string | null;
  renditions?: Array<{
    id: number;
    kind: "sdr" | "pq" | "hlg";
    file: DirectusFileId;
    transfer: string | null;
    primaries: string | null;
    bit_depth: number | null;
    is_default: boolean | number;
  }>;
  published: boolean | number;
  sort_order: number | null;
  created_at: string | null;
  updated_at: string | null;
};

export type Album = {
  id: number;
  title: string;
  slug: string;
  description: string | null;
  cover_image: DirectusFileId;
  published: boolean | number;
  created_at: string | null;
  updated_at: string | null;
  photos?: AlbumPhoto[];
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
  "id,title,slug,cover_image,category,published,created_at";
const POST_DETAIL_FIELDS =
  "id,title,slug,content,cover_image,backgroundimage,tags,category,published,created_at,updated_at";

const VIDEO_LIST_FIELDS =
  "id,title,slug,description,cover_image,category,tags,published,sort_order,created_at," +
  "masters.id,masters.label,masters.type,masters.hls_url,masters.is_default,masters.sort_order";
const VIDEO_DETAIL_FIELDS =
  "id,title,slug,description,cover_image,category,tags,published,sort_order,created_at,updated_at,masters.*";
const ALBUM_LIST_FIELDS =
  "id,title,slug,description,cover_image,published,created_at,updated_at," +
  "photos.id,photos.album_id,photos.sdr_image,photos.hdr_image,photos.caption," +
  "photos.alt_text,photos.hdr_transfer,photos.hdr_primaries,photos.hdr_bit_depth," +
  "photos.film_scan_frame_id,photos.film_stock,photos.film_process,photos.film_scanner," +
  "photos.film_frame_format,photos.renditions.id,photos.renditions.kind," +
  "photos.renditions.file,photos.renditions.transfer,photos.renditions.primaries," +
  "photos.renditions.bit_depth,photos.renditions.is_default," +
  "photos.published,photos.sort_order,photos.created_at,photos.updated_at";
const ALBUM_DETAIL_FIELDS = ALBUM_LIST_FIELDS;

/* ---- Config ---- */
let cachedToken: string | null = null;
let pendingToken: Promise<string | null> | null = null;

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

async function login() {
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

async function getToken() {
  if (cachedToken) return cachedToken;

  if (!pendingToken) {
    pendingToken = login().finally(() => {
      pendingToken = null;
    });
  }

  return pendingToken;
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
    if (cachedToken === token) {
      cachedToken = null;
    }
    return directusFetch<T>(pathname, true);
  }

  if (!response.ok) {
    throw new Error(`Directus request failed: ${pathname} ${response.status}`);
  }

  return (await response.json()) as T;
}

export function assetUrl(
  fileId: DirectusFileId,
  preset?: AlbumAssetPreset,
) {
  if (!fileId) return null;
  if (preset && preset !== "album-cover" && preset !== "album-thumb") {
    throw new Error(`Unsupported asset preset: ${preset}`);
  }
  const suffix = preset ? `?key=${encodeURIComponent(preset)}` : "";
  return `/api/assets/${fileId}${suffix}`;
}

export function albumPictureSources(
  photo: Pick<AlbumPhoto, "sdr_image" | "hdr_image" | "renditions">,
) {
  const hlg = photo.renditions?.find((rendition) => rendition.kind === "hlg");
  return {
    thumbnail: assetUrl(photo.sdr_image, "album-thumb"),
    sdr: assetUrl(photo.sdr_image),
    hdr: assetUrl(photo.hdr_image),
    hlg: assetUrl(hlg?.file ?? null),
  };
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

export function filterPublishedAlbums(albums: Album[]) {
  return albums
    .filter(isPublished)
    .map((album) => ({
      ...album,
      photos: [...(album.photos ?? [])]
        .filter(isPublished)
        .sort((left, right) => {
          const orderDifference =
            (left.sort_order ?? 0) - (right.sort_order ?? 0);
          return orderDifference || left.id - right.id;
        }),
    }));
}

function addPublicAlbumFilters(params: URLSearchParams) {
  params.set("filter[published][_eq]", "true");
  params.set("deep[photos][_filter][published][_eq]", "true");
  params.set("deep[photos][_sort]", "sort_order,id");
}

export async function getAlbums(limit = 100) {
  const params = new URLSearchParams({
    fields: ALBUM_LIST_FIELDS,
    sort: "-created_at,-id",
    limit: String(limit),
  });
  addPublicAlbumFilters(params);
  const response = await directusFetch<DirectusListResponse<Album>>(
    `/items/albums?${params.toString()}`,
  );
  return filterPublishedAlbums(response.data);
}

export async function getAlbum(slug: string) {
  const params = new URLSearchParams({
    fields: ALBUM_DETAIL_FIELDS,
    "filter[slug][_eq]": slug,
    limit: "1",
  });
  addPublicAlbumFilters(params);
  const response = await directusFetch<DirectusListResponse<Album>>(
    `/items/albums?${params.toString()}`,
  );
  return filterPublishedAlbums(response.data)[0] ?? null;
}

export type SiteSettings = {
  background_image: DirectusFileId;
  background_blur: number | null;
  background_images?: Array<{ directus_files_id: DirectusFileId }> | null;
  accent_color?: string | null;
};

export async function getSiteSettings(): Promise<SiteSettings | null> {
  try {
    const response = await directusFetch<{ data: SiteSettings }>(
      "/items/site_settings?fields=background_image,background_blur,background_images.directus_files_id,accent_color"
    );
    return response.data ?? null;
  } catch {
    // Preserve background settings while accent_color is rolling out.
    try {
      const response = await directusFetch<{ data: SiteSettings }>(
        "/items/site_settings?fields=background_image,background_blur,background_images.directus_files_id"
      );
      return response.data ?? null;
    } catch {
      return null;
    }
  }
}

/** All configured background image URLs: default first, then the gallery. */
export function siteBackgroundUrls(settings: SiteSettings | null): string[] {
  if (!settings) return [];

  const urls = [
    assetUrl(settings.background_image),
    ...(settings.background_images ?? []).map((row) =>
      assetUrl(row.directus_files_id)
    ),
  ].filter((url): url is string => Boolean(url));

  return [...new Set(urls)];
}

export async function getCounts() {
  const params = new URLSearchParams({ "aggregate[count]": "*" });
  addPublishedFilter(params);
  const qs = params.toString();

  const [postsRes, videosRes, albumsRes] = await Promise.all([
    directusFetch<DirectusAggregateResponse>(`/items/posts?${qs}`),
    directusFetch<DirectusAggregateResponse>(`/items/video_projects?${qs}`),
    directusFetch<DirectusAggregateResponse>(`/items/albums?${qs}`),
  ]);

  return {
    posts: aggregateCount(postsRes),
    videos: aggregateCount(videosRes),
    albums: aggregateCount(albumsRes),
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
