export type ManagedPhoto = {
  id: number;
  albumId: number;
  sdrImage: string;
  hdrImage: string | null;
  caption: string;
  altText: string;
  hdrTransfer: "pq" | "hlg" | null;
  hdrPrimaries: string | null;
  hdrBitDepth: number | null;
  published: boolean;
  sortOrder: number;
  createdAt: string | null;
  updatedAt: string | null;
};

export type ManagedAlbum = {
  id: number;
  title: string;
  slug: string;
  description: string;
  coverImage: string | null;
  published: boolean;
  photoCount: number;
  publishedPhotoCount: number;
  hdrPhotoCount: number;
  photos: ManagedPhoto[];
  createdAt: string | null;
  updatedAt: string | null;
  url: string;
};

export type NamedFile = {
  name: string;
};

export type AlbumFilePair<T extends NamedFile = NamedFile> = {
  key: string;
  sdr: T;
  hdr: T | null;
};

export function albumFileKey(filename: string) {
  const basename = filename.split(/[\\/]/).at(-1)?.normalize("NFC") ?? "";
  const extensionIndex = basename.lastIndexOf(".");
  const stem = (extensionIndex > 0 ? basename.slice(0, extensionIndex) : basename)
    .trim()
    .toLocaleLowerCase("en-US");
  if (!stem) {
    throw new Error("文件名必须包含非空的主体名称。");
  }
  return stem;
}

export function pairAlbumFileSelections<T extends NamedFile>(
  sdrFiles: T[],
  hdrFiles: T[],
) {
  const errors: string[] = [];
  const sdrByKey = indexFiles(sdrFiles, "SDR", errors);
  const hdrByKey = indexFiles(hdrFiles, "HDR", errors);

  for (const key of hdrByKey.keys()) {
    if (!sdrByKey.has(key)) {
      errors.push(`HDR 文件“${key}”没有同名 SDR 文件。`);
    }
  }

  const pairs: AlbumFilePair<T>[] = [...sdrByKey].map(([key, sdr]) => ({
    key,
    sdr,
    hdr: hdrByKey.get(key) ?? null,
  }));

  if (!pairs.length) {
    errors.push("请至少选择一张 SDR 照片。");
  }

  return { pairs, errors };
}

function indexFiles<T extends NamedFile>(
  files: T[],
  label: string,
  errors: string[],
) {
  const result = new Map<string, T>();
  for (const file of files) {
    try {
      const key = albumFileKey(file.name);
      if (result.has(key)) {
        errors.push(`${label} 文件名“${key}”重复。`);
      } else {
        result.set(key, file);
      }
    } catch (error) {
      errors.push(error instanceof Error ? error.message : "文件名无效。");
    }
  }
  return result;
}

export async function albumApiRequest<T>(
  pathname: string,
  token: string,
  init: RequestInit = {},
): Promise<T> {
  const response = await fetch(pathname, {
    ...init,
    headers: {
      Authorization: `Bearer ${token.trim()}`,
      ...(init.body instanceof FormData
        ? {}
        : { "Content-Type": "application/json" }),
      ...(init.headers || {}),
    },
    cache: "no-store",
  });
  const payload = (await response.json().catch(() => null)) as
    | (T & { error?: string; message?: string })
    | null;
  if (!response.ok) {
    throw new Error(
      payload?.error ||
        payload?.message ||
        `相簿接口请求失败（${response.status}）。`,
    );
  }
  if (!payload) {
    throw new Error("相簿接口返回了空响应。");
  }
  return payload;
}

export async function fetchManagedAlbums(token: string) {
  const response = await albumApiRequest<{
    status: string;
    albums: ManagedAlbum[];
  }>("/api/albums/manage", token);
  return response.albums;
}
