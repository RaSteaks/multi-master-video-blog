import type { Metadata } from "next";
import Link from "next/link";
import { AlbumsToolbar } from "@/components/AlbumsToolbar";
import { assetUrl, getAlbums } from "@/lib/directus";
import { siteConfig } from "@/lib/site-config";

export const metadata: Metadata = {
  title: `相簿 — ${siteConfig.title}`,
  description: "以 SDR 缩略图浏览相簿，并在支持的显示设备上查看 HDR 原片。",
};

export default async function AlbumsPage() {
  const albums = await getAlbums();

  return (
    <main className="shell page-stack album-index">
      <header className="album-page-header">
        <div className="page-header">
          <p className="eyebrow">Darkroom contact sheets</p>
          <h1>相簿</h1>
          <p className="summary">
            网格始终使用可靠的 SDR 印样；进入灯箱后，HDR 显示设备会自动选择
            PQ 或 HLG AVIF 原片。
          </p>
        </div>
        <AlbumsToolbar
          albums={albums.map((album) => ({
            id: album.id,
            title: album.title,
            slug: album.slug,
            description: album.description || "",
            published: true,
          }))}
        />
      </header>

      {albums.length ? (
        <ol className="album-contact-sheet">
          {albums.map((album, index) => {
            const photos = album.photos ?? [];
            const coverId =
              album.cover_image || photos[0]?.sdr_image || null;
            const cover = assetUrl(coverId, "album-cover");
            const hdrCount = photos.filter((photo) => photo.hdr_image).length;

            return (
              <li key={album.id}>
                <Link
                  className="album-card"
                  href={`/albums/${album.slug}`}
                  aria-label={`打开相簿“${album.title}”，共 ${photos.length} 张照片`}
                >
                  <div className="album-card-frame">
                    <span className="album-frame-index" aria-hidden="true">
                      {String(index + 1).padStart(2, "0")}
                    </span>
                    {cover ? (
                      <img
                        src={cover}
                        alt=""
                        loading="lazy"
                        decoding="async"
                      />
                    ) : (
                      <div className="album-card-placeholder" aria-hidden="true">
                        <span>等待第一张底片</span>
                      </div>
                    )}
                    {hdrCount ? (
                      <span className="album-hdr-badge">
                        HDR <b>{hdrCount}</b>
                      </span>
                    ) : null}
                  </div>
                  <div className="album-card-copy">
                    <div>
                      <p className="album-card-kicker">
                        {photos.length} 张照片
                        {hdrCount ? ` · ${hdrCount} 组 HDR` : " · SDR"}
                      </p>
                      <h2>{album.title}</h2>
                    </div>
                    <span className="album-card-arrow" aria-hidden="true">
                      ↗
                    </span>
                    {album.description ? (
                      <p>{album.description}</p>
                    ) : (
                      <p className="album-card-empty-copy">尚未填写相簿说明。</p>
                    )}
                  </div>
                </Link>
              </li>
            );
          })}
        </ol>
      ) : (
        <section className="album-empty-state" role="status">
          <span className="album-empty-mark" aria-hidden="true">
            00
          </span>
          <div>
            <h2>接触印样还是空的</h2>
            <p>使用上方“新建相簿”，再从同一页面上传第一批 SDR／HDR 照片。</p>
          </div>
        </section>
      )}
    </main>
  );
}
