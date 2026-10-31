"use client";

import Link from "next/link";
import { useRouter, useSearchParams } from "next/navigation";
import {
  Suspense,
  useCallback,
  useEffect,
  useId,
  useLayoutEffect,
  useMemo,
  useRef,
  useState,
  type FormEvent,
  type MouseEvent,
} from "react";
import {
  albumApiRequest,
  fetchManagedAlbum,
  uploadAlbumFormData,
  type ManagedAlbum,
  type ManagedPhoto,
} from "@/lib/album-management";
import { ActionMenu } from "@/components/ActionMenu";
import { canAuthorize, requestAuthorSignIn, useAuthorDevice, useAuthorSession } from "@/lib/author-session";
import { AuthorCredential } from "@/components/AuthorCredential";
import { AlbumPhotoUploader, UploadIcon } from "@/components/AlbumPhotoUploader";
import { albumThumbSrcSet, assetUrl } from "@/lib/asset-url";
import {
  IDENTITY_TRANSFORM,
  aspectsMatch,
  axisOffset,
  boxIsVisible,
  createVelocityTracker,
  dismissProgress,
  dismissScale,
  flipTransform,
  gestureOutcome,
  lockGestureAxis,
  parseLayerTransform,
  swipeDuration,
  transformValue,
  untransformedBox,
  type GestureAxis,
  type LayerTransform,
} from "@/lib/lightbox-gesture";
import {
  canSpeculativelyPreload,
  createImagePreloader,
  neighborIndices,
  photoChangeKind,
  photoRangeSource,
  preferredPhotoRange,
  type ImagePreloader,
  type PhotoRange,
  type PreloadImage,
} from "@/lib/lightbox-media";
import { animateElement, prefersReducedMotion, readMotionTokens } from "@/lib/media-motion";
import styles from "./AlbumLightbox.module.css";
import { AuthenticatedAssetImage } from "./AuthenticatedAssetImage";

export type GalleryPhoto = {
  id: number;
  sdrImage: string;
  hdrImage: string | null;
  hlgImage: string | null;
  thumbnailUrl: string;
  thumbnailSrcSet: string | null;
  /** SDR pixel size, when known, used to reserve the tile's space before the image loads. */
  width: number | null;
  height: number | null;
  sdrUrl: string;
  hdrUrl: string | null;
  hlgUrl: string | null;
  caption: string;
  altText: string;
  hdrTransfer: "pq" | "hlg" | null;
  hdrPrimaries: string | null;
  hdrBitDepth: number | null;
  filmStock: string | null;
  filmProcess: string | null;
  filmScanner: string | null;
  filmFrameFormat: string | null;
  published: boolean;
  sortOrder: number;
};

/** Mirrors the .album-photo-grid responsive tracks and the 1120px shell in globals.css. */
const ALBUM_TILE_SIZES =
  "(max-width: 640px) calc(100vw - 40px), (max-width: 900px) calc(50vw - 30px), 360px";

export type GalleryAlbum = {
  id: number;
  title: string;
  slug: string;
  description: string;
  coverImage: string | null;
  published: boolean;
  photos: GalleryPhoto[];
};

export function AlbumGallery({
  initialAlbum,
  initialManagedAlbum = null,
  initialToken = "",
  embedded = false,
  onManagedAlbumChange,
}: {
  initialAlbum: GalleryAlbum;
  initialManagedAlbum?: ManagedAlbum | null;
  initialToken?: string;
  embedded?: boolean;
  onManagedAlbumChange?: (album: ManagedAlbum) => void;
}) {
  const router = useRouter();
  const author = useAuthorSession();
  const device = useAuthorDevice();
  const [adminOpen, setAdminOpen] = useState(Boolean(initialManagedAlbum));
  const [token, setToken] = useState(initialToken);
  const [managedAlbum, setManagedAlbum] = useState<ManagedAlbum | null>(
    initialManagedAlbum,
  );
  const [uploadOpen, setUploadOpen] = useState(false);
  const [adminBusy, setAdminBusy] = useState(false);
  const [adminError, setAdminError] = useState("");
  const [adminNotice, setAdminNotice] = useState("");
  const [orderDirty, setOrderDirty] = useState(false);
  const [editingPhoto, setEditingPhoto] = useState<ManagedPhoto | null>(null);
  const [lightboxIndex, setLightboxIndex] = useState<number | null>(null);
  const [failedHdr, setFailedHdr] = useState<Set<number>>(() => new Set());
  const lastTrigger = useRef<HTMLButtonElement | null>(null);
  const uploadPanelRef = useRef<HTMLDivElement | null>(null);
  const galleryRef = useRef<HTMLElement | null>(null);
  // The lightbox morphs to and from the current photo's tile; null means it fades instead.
  const findTile = useCallback(
    (photoId: number) =>
      galleryRef.current?.querySelector<HTMLElement>(`[data-photo-tile="${photoId}"] img`) ?? null,
    [],
  );

  const managedPhotos = useMemo(
    () => managedAlbum?.photos.map(managedPhotoToGallery) ?? null,
    [managedAlbum],
  );
  const visibleAlbum = managedAlbum
    ? {
        id: managedAlbum.id,
        title: managedAlbum.title,
        slug: managedAlbum.slug,
        description: managedAlbum.description,
        coverImage: managedAlbum.coverImage,
        published: managedAlbum.published,
        photos: managedPhotos ?? [],
      }
    : initialAlbum;
  const photos = visibleAlbum.photos;
  const publishedCount = photos.filter((photo) => photo.published).length;
  const hdrCount = photos.filter((photo) => photo.hdrImage).length;

  useEffect(() => {
    if (lightboxIndex !== null && lightboxIndex >= photos.length) {
      setLightboxIndex(photos.length ? photos.length - 1 : null);
    }
  }, [lightboxIndex, photos.length]);

  useEffect(() => {
    if (uploadOpen && managedAlbum) {
      uploadPanelRef.current?.scrollIntoView({ block: "nearest", behavior: "smooth" });
    }
  }, [uploadOpen, Boolean(managedAlbum)]); // eslint-disable-line react-hooks/exhaustive-deps

  async function loadAdminAlbum() {
    if (!canAuthorize(token)) {
      setAdminError("请输入管理员令牌。");
      return null;
    }
    setAdminBusy(true);
    setAdminError("");
    try {
      // Management fetches only the selected album, including draft photos.
      const album = await fetchManagedAlbum(token, initialAlbum.id);
      if (!album) {
        throw new Error("管理列表中未找到当前相簿。");
      }
      setManagedAlbum(album);
      onManagedAlbumChange?.(album);
      setOrderDirty(false);
      setAdminNotice("管理模式已启用，草稿照片也会显示。");
      return album;
    } catch (cause) {
      setAdminError(cause instanceof Error ? cause.message : "验证失败。");
      return null;
    } finally {
      setAdminBusy(false);
    }
  }

  async function refreshAdminAlbum() {
    const album = await fetchManagedAlbum(token, initialAlbum.id);
    if (!album) throw new Error("管理列表中未找到当前相簿。");
    setManagedAlbum(album);
    onManagedAlbumChange?.(album);
    setOrderDirty(false);
    return album;
  }

  async function mutate<T>(
    action: () => Promise<T>,
    successMessage: string,
  ): Promise<T | null> {
    setAdminBusy(true);
    setAdminError("");
    setAdminNotice("");
    try {
      const result = await action();
      await refreshAdminAlbum();
      setAdminNotice(successMessage);
      router.refresh();
      return result;
    } catch (cause) {
      setAdminError(cause instanceof Error ? cause.message : "操作失败。");
      return null;
    } finally {
      setAdminBusy(false);
    }
  }

  /** Open verification before the uploader; either a session or manual token may authorize it. */
  const openUpload = useCallback(() => {
    setAdminOpen(true);
    setUploadOpen(true);
  }, []);

  function toggleAdmin() {
    if (adminOpen) {
      setAdminOpen(false);
      setUploadOpen(false);
      setManagedAlbum(null);
      setToken("");
      setAdminError("");
      setAdminNotice("");
      setOrderDirty(false);
      return;
    }
    setAdminOpen(true);
  }

  function openLightbox(
    index: number,
    event: MouseEvent<HTMLButtonElement>,
  ) {
    lastTrigger.current = event.currentTarget;
    setLightboxIndex(index);
  }

  function closeLightbox() {
    setLightboxIndex(null);
    // Restore the opener without undoing scrolling or resizing that happened while the modal was open.
    window.setTimeout(() => lastTrigger.current?.focus({ preventScroll: true }), 0);
  }

  function movePhoto(index: number, direction: -1 | 1) {
    if (!managedAlbum) return;
    const target = index + direction;
    if (target < 0 || target >= managedAlbum.photos.length) return;
    const next = [...managedAlbum.photos];
    [next[index], next[target]] = [next[target], next[index]];
    setManagedAlbum({
      ...managedAlbum,
      photos: next.map((photo, photoIndex) => ({
        ...photo,
        sortOrder: photoIndex,
      })),
    });
    setOrderDirty(true);
  }

  async function saveOrder() {
    if (!managedAlbum) return;
    await mutate(
      () =>
        albumApiRequest(
          `/api/albums/${managedAlbum.id}/photos/reorder`,
          token,
          {
            method: "POST",
            body: JSON.stringify({
              photoIds: managedAlbum.photos.map((photo) => photo.id),
            }),
          },
        ),
      "照片顺序已保存。",
    );
  }

  async function setCover(photo: GalleryPhoto) {
    if (!managedAlbum || !photo.published) return;
    await mutate(
      () =>
        albumApiRequest(`/api/albums/${managedAlbum.id}/cover`, token, {
          method: "PUT",
          body: JSON.stringify({ photoId: photo.id }),
        }),
      "相簿封面已更新。",
    );
  }

  async function deletePhoto(photo: GalleryPhoto) {
    if (!managedAlbum) return;
    const confirmed = window.confirm(
      `确定删除这张照片吗？其专属 SDR${photo.hdrImage ? " 与 HDR" : ""} 文件也会被删除，此操作无法撤销。`,
    );
    if (!confirmed) return;
    const result = await mutate(
      () =>
        albumApiRequest<{
          status: "ok" | "partial";
          deletedPhotoId: number;
          cleanupRequired: boolean;
          orphanFileIds: string[];
          message?: string;
        }>(
          `/api/albums/${managedAlbum.id}/photos/${photo.id}`,
          token,
          { method: "DELETE" },
      ),
      "照片及其文件已删除。",
    );
    if (result?.cleanupRequired) {
      setAdminNotice("");
      setAdminError(
        result.message ||
          `照片记录已删除，但文件 ${result.orphanFileIds.join("、")} 需要手动清理。`,
      );
    }
  }

  const selectedPhoto =
    lightboxIndex === null ? null : photos[lightboxIndex] ?? null;
  const RootElement = embedded ? "div" : "main";
  const TitleElement = embedded ? "h2" : "h1";

  return (
    <RootElement
      ref={(element: HTMLElement | null) => {
        galleryRef.current = element;
      }}
      className={`${embedded ? "album-manager-workspace " : "shell page-stack "}album-detail`}
    >
      {!embedded ? <Suspense fallback={null}><AlbumUploadRequest onRequest={openUpload} /></Suspense> : null}
      <header className="album-detail-header">
        <div>
          {!embedded ? (
            <Link className="album-back-link" href="/albums">
              <span aria-hidden="true">←</span> 返回接触印样
            </Link>
          ) : null}
          <p className="eyebrow">Album / {visibleAlbum.slug}</p>
          <TitleElement>{visibleAlbum.title}</TitleElement>
          {visibleAlbum.description ? (
            <p className="summary">{visibleAlbum.description}</p>
          ) : null}
        </div>
        <div className="album-detail-aside">
          {adminOpen ? (
            <dl className="album-detail-stats">
              <div>
                <dt>照片</dt>
                <dd>
                  {managedAlbum
                    ? `${publishedCount}/${photos.length}`
                    : photos.length}
                </dd>
              </div>
              <div>
                <dt>HDR 配对</dt>
                <dd>{hdrCount}</dd>
              </div>
              <div>
                <dt>状态</dt>
                <dd>{visibleAlbum.published ? "公开" : "草稿"}</dd>
              </div>
            </dl>
          ) : null}
          <div className="album-detail-actions">
            {embedded ? (
              <button
                className="album-action-button"
                type="button"
                aria-expanded={uploadOpen}
                aria-controls="album-upload-panel"
                onClick={openUpload}
              >
                <UploadIcon />
                上传照片
              </button>
            ) : device ? (
              <ActionMenu
                label="管理此相簿"
                triggerClassName="album-action-button"
                trigger={
                  <>
                    <SlidersIcon />
                    {adminOpen ? "管理中" : "管理"}
                    <ChevronIcon />
                  </>
                }
                groups={[
                  {
                    items: [
                      { label: "上传照片", icon: <UploadIcon />, onSelect: () => author.author ? openUpload() : requestAuthorSignIn(openUpload) },
                      {
                        label: adminOpen ? "退出管理模式" : "进入管理模式",
                        icon: <SlidersIcon />,
                        onSelect: () => author.author ? toggleAdmin() : requestAuthorSignIn(toggleAdmin),
                      },
                    ],
                  },
                ]}
              />
            ) : null}
          </div>
        </div>
      </header>

      {adminOpen ? (
        <section
          className="album-admin-panel"
          id="album-admin-panel"
          aria-label="相簿管理模式"
        >
          {!managedAlbum ? (
            <form
              className="album-admin-login"
              onSubmit={(event) => {
                event.preventDefault();
                void loadAdminAlbum();
              }}
            >
              <div>
                <p className="eyebrow">受保护的管理视图</p>
                <h2>载入草稿与编辑工具</h2>
                <p>令牌只保存在当前组件内，不写入持久存储。</p>
              </div>
              <AuthorCredential token={token}><label className="album-field">
                <span>管理员令牌</span>
                <input
                  type="password"
                  value={token}
                  onChange={(event) => setToken(event.target.value)}
                  autoComplete="new-password"
                  autoFocus
                  required={!author.author}
                />
              </label></AuthorCredential>
              <button
                className="album-action-button album-action-button--primary"
                type="submit"
                disabled={adminBusy}
              >
                {adminBusy ? "正在验证…" : "进入管理模式"}
              </button>
            </form>
          ) : (
            <>
              {uploadOpen ? (
                <div id="album-upload-panel" ref={uploadPanelRef}>
                  <AlbumPhotoUploader
                    albumId={managedAlbum.id}
                    token={token}
                    onClose={() => setUploadOpen(false)}
                    onUploaded={async (message) => {
                      await refreshAdminAlbum();
                      setAdminNotice(message);
                      router.refresh();
                    }}
                  />
                </div>
              ) : null}
              <AlbumAdminForm
                key={`${managedAlbum.id}-${managedAlbum.updatedAt}`}
                album={managedAlbum}
                busy={adminBusy}
                onSave={async (patch) => {
                  const saved = await mutate(
                    () =>
                      albumApiRequest(
                        `/api/albums/${managedAlbum.id}`,
                        token,
                        {
                          method: "PATCH",
                          body: JSON.stringify(patch),
                        },
                      ),
                    "相簿标题、说明与发布状态已保存。",
                  );
                  if (saved && !patch.published && !embedded) {
                    router.push("/albums");
                  }
                }}
              />
              <div className="album-admin-order">
                <p>
                  使用每张照片下方的箭头调整顺序，再统一保存。封面只能使用已发布
                  SDR 照片。
                </p>
                <button
                  className="album-action-button album-action-button--primary"
                  type="button"
                  disabled={adminBusy || !orderDirty}
                  onClick={() => void saveOrder()}
                >
                  {orderDirty ? "保存照片顺序" : "顺序未更改"}
                </button>
              </div>
            </>
          )}
          <p
            className={`album-admin-feedback${adminError ? " is-error" : ""}`}
            role={adminError ? "alert" : "status"}
          >
            {adminError || adminNotice}
          </p>
        </section>
      ) : null}

      {photos.length ? (
        <ol className="album-photo-grid">
          {photos.map((photo, index) => {
            const isCover = visibleAlbum.coverImage === photo.sdrImage;
            return (
              <li
                className={!photo.published ? "is-draft" : undefined}
                key={photo.id}
              >
                <article className="album-photo-tile">
                  <button
                    className="album-photo-open"
                    type="button"
                    data-photo-tile={photo.id}
                    onClick={(event) => openLightbox(index, event)}
                    aria-label={`查看第 ${index + 1} 张照片${
                      photo.caption ? `：${photo.caption}` : ""
                    }`}
                  >
                    {/* Draft tiles use authenticated blobs; public tiles keep ordinary URLs/srcsets. */}
                    <AuthenticatedAssetImage
                      token={managedAlbum ? token : undefined}
                      src={photo.thumbnailUrl}
                      srcSet={photo.thumbnailSrcSet ?? undefined}
                      sizes={
                        photo.thumbnailSrcSet ? ALBUM_TILE_SIZES : undefined
                      }
                      alt={photo.altText || ""}
                      width={photo.width ?? undefined}
                      height={photo.height ?? undefined}
                      loading={index < 3 ? "eager" : "lazy"}
                      fetchPriority={index === 0 ? "high" : "auto"}
                      decoding="async"
                    />
                    <span className="album-photo-number" aria-hidden="true">
                      {String(index + 1).padStart(2, "0")}
                    </span>
                    {photo.hdrImage ? (
                      <span className="album-photo-range">
                        {photo.hdrTransfer?.toUpperCase() || "HDR"}
                      </span>
                    ) : null}
                    {!photo.published ? (
                      <span className="album-photo-draft">草稿</span>
                    ) : null}
                  </button>
                  <div className="album-photo-caption">
                    <p>{photo.caption || photo.altText || "未命名照片"}</p>
                    <span>{photo.hdrImage ? "SDR + HDR" : "SDR"}</span>
                  </div>
                  {managedAlbum ? (
                    <div className="album-photo-controls">
                      <div>
                        <button
                          type="button"
                          aria-label="向前移动"
                          disabled={adminBusy || index === 0}
                          onClick={() => movePhoto(index, -1)}
                        >
                          ←
                        </button>
                        <button
                          type="button"
                          aria-label="向后移动"
                          disabled={adminBusy || index === photos.length - 1}
                          onClick={() => movePhoto(index, 1)}
                        >
                          →
                        </button>
                      </div>
                      <button
                        type="button"
                        disabled={adminBusy || !photo.published || isCover}
                        onClick={() => void setCover(photo)}
                      >
                        {isCover ? "当前封面" : "设为封面"}
                      </button>
                      <button
                        type="button"
                        disabled={adminBusy}
                        onClick={() => {
                          const managed = managedAlbum.photos.find(
                            (item) => item.id === photo.id,
                          );
                          if (managed) setEditingPhoto(managed);
                        }}
                      >
                        编辑
                      </button>
                      <button
                        className="is-danger"
                        type="button"
                        disabled={adminBusy}
                        onClick={() => void deletePhoto(photo)}
                      >
                        删除
                      </button>
                    </div>
                  ) : null}
                </article>
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
            <h2>这个相簿还没有公开照片</h2>
            <p>{device ? "打开标题区的“管理”，选择“上传照片”加入第一批照片。" : "照片整理中。"}</p>
          </div>
        </section>
      )}

      {selectedPhoto && lightboxIndex !== null ? (
        <PhotoLightbox
          token={managedAlbum ? token : undefined}
          photo={selectedPhoto}
          index={lightboxIndex}
          total={photos.length}
          photos={photos}
          onSelect={setLightboxIndex}
          hdrFailed={failedHdr.has(selectedPhoto.id)}
          failedHdrIds={failedHdr}
          findTile={findTile}
          onHdrFailure={() =>
            setFailedHdr((current) => {
              const next = new Set(current);
              next.add(selectedPhoto.id);
              return next;
            })
          }
          onPrevious={() =>
            setLightboxIndex((current) =>
              current === null ? null : (current - 1 + photos.length) % photos.length,
            )
          }
          onNext={() =>
            setLightboxIndex((current) =>
              current === null ? null : (current + 1) % photos.length,
            )
          }
          onClose={closeLightbox}
        />
      ) : null}

      {editingPhoto && managedAlbum ? (
        <PhotoEditDialog
          photo={editingPhoto}
          busy={adminBusy}
          onClose={() => setEditingPhoto(null)}
          onSave={async (patch) => {
            const saved = await mutate(
              () =>
                albumApiRequest(
                  `/api/albums/${managedAlbum.id}/photos/${editingPhoto.id}`,
                  token,
                  {
                    method: "PATCH",
                    body: JSON.stringify(patch),
                  },
                ),
              "照片说明、替代文本与发布状态已保存。",
            );
            if (saved) setEditingPhoto(null);
          }}
          onUploadHdr={async (file, onProgress) => {
            setAdminBusy(true);
            setAdminError("");
            setAdminNotice("");
            const formData = new FormData();
            formData.append("hdrFiles", file, file.name);
            try {
              const response = await uploadAlbumFormData<{
                status: string;
                photo: ManagedPhoto;
                cleanupRequired?: boolean;
                orphanFileIds?: string[];
              }>(
                `/api/albums/${managedAlbum.id}/photos/${editingPhoto.id}/hdr`,
                token,
                formData,
                onProgress,
              );
              const refreshedAlbum = await refreshAdminAlbum();
              const refreshedPhoto = refreshedAlbum.photos.find(
                (photo) => photo.id === editingPhoto.id,
              );
              if (refreshedPhoto) setEditingPhoto(refreshedPhoto);
              setFailedHdr((current) => {
                const next = new Set(current);
                next.delete(editingPhoto.id);
                return next;
              });
              setAdminNotice(
                response.cleanupRequired
                  ? "HDR 已替换，但旧文件需要在 Directus 中手动清理。"
                  : "HDR 版本已上传并完成手动配对。",
              );
            } catch (cause) {
              const message =
                cause instanceof Error ? cause.message : "HDR 上传失败。";
              setAdminError(message);
              throw cause;
            } finally {
              setAdminBusy(false);
            }
          }}
        />
      ) : null}
    </RootElement>
  );
}

// Isolate query-string subscription from the server-rendered public gallery.
function AlbumUploadRequest({ onRequest }: { onRequest: () => void }) {
  const search = useSearchParams();
  const router = useRouter();
  useEffect(() => {
    if (search.get("action") !== "upload") return;
    onRequest();
    const url = new URL(location.href);
    url.searchParams.delete("action");
    router.replace(`${url.pathname}${url.search}${url.hash}`, { scroll: false });
  }, [search, router, onRequest]);
  return null;
}

export function ManagedAlbumGallery({
  album,
  token,
  onAlbumChange,
}: {
  album: ManagedAlbum;
  token: string;
  onAlbumChange?: (album: ManagedAlbum) => void;
}) {
  return (
    <AlbumGallery
      initialAlbum={managedAlbumToGallery(album)}
      initialManagedAlbum={album}
      initialToken={token}
      embedded
      onManagedAlbumChange={onAlbumChange}
    />
  );
}

function AlbumAdminForm({
  album,
  busy,
  onSave,
}: {
  album: ManagedAlbum;
  busy: boolean;
  onSave: (patch: {
    title: string;
    description: string;
    published: boolean;
  }) => Promise<void>;
}) {
  const [title, setTitle] = useState(album.title);
  const [description, setDescription] = useState(album.description);
  const [published, setPublished] = useState(album.published);

  return (
    <form
      className="album-admin-form"
      onSubmit={(event) => {
        event.preventDefault();
        void onSave({ title, description, published });
      }}
    >
      <div className="album-form-grid">
        <label className="album-field">
          <span>相簿标题</span>
          <input
            value={title}
            onChange={(event) => setTitle(event.target.value)}
            maxLength={200}
            required
          />
        </label>
        <label className="album-field">
          <span>Slug（只读）</span>
          <input value={album.slug} readOnly />
        </label>
      </div>
      <label className="album-field">
        <span>相簿说明</span>
        <textarea
          value={description}
          onChange={(event) => setDescription(event.target.value)}
          maxLength={5000}
          rows={3}
        />
      </label>
      <div className="album-admin-form-footer">
        <label className="album-switch album-switch--compact">
          <input
            type="checkbox"
            checked={published}
            onChange={(event) => setPublished(event.target.checked)}
          />
          <span>
            <strong>{published ? "相簿公开" : "保存为草稿"}</strong>
          </span>
        </label>
        <button
          className="album-action-button"
          type="submit"
          disabled={busy || !title.trim()}
        >
          {busy ? "保存中…" : "保存相簿"}
        </button>
      </div>
    </form>
  );
}

function PhotoEditDialog({
  photo,
  busy,
  onClose,
  onSave,
  onUploadHdr,
}: {
  photo: ManagedPhoto;
  busy: boolean;
  onClose: () => void;
  onSave: (patch: {
    caption: string;
    altText: string;
    published: boolean;
  }) => Promise<void>;
  onUploadHdr: (
    file: File,
    onProgress: (progress: number) => void,
  ) => Promise<void>;
}) {
  const dialogRef = useRef<HTMLDialogElement>(null);
  const hdrInputRef = useRef<HTMLInputElement>(null);
  const headingId = useId();
  const hdrHeadingId = useId();
  const [caption, setCaption] = useState(photo.caption);
  const [altText, setAltText] = useState(photo.altText);
  const [published, setPublished] = useState(photo.published);
  const [hdrFile, setHdrFile] = useState<File | null>(null);
  const [hdrProgress, setHdrProgress] = useState(0);
  const [hdrUploading, setHdrUploading] = useState(false);
  const [hdrError, setHdrError] = useState("");
  const [hdrSuccess, setHdrSuccess] = useState("");

  useEffect(() => {
    dialogRef.current?.showModal();
  }, []);

  async function uploadHdr() {
    if (!hdrFile) {
      setHdrError("请先选择一张 HDR AVIF 照片。");
      return;
    }
    if (hdrFile.size > 64 * 1024 * 1024) {
      setHdrError("HDR 文件不能超过 64 MiB。");
      return;
    }
    setHdrError("");
    setHdrSuccess("");
    setHdrProgress(0);
    setHdrUploading(true);
    try {
      await onUploadHdr(hdrFile, setHdrProgress);
      setHdrFile(null);
      setHdrSuccess(photo.hdrImage ? "HDR 版本已替换。" : "HDR 版本已配对。");
    } catch (cause) {
      setHdrError(cause instanceof Error ? cause.message : "HDR 上传失败。");
    } finally {
      setHdrUploading(false);
    }
  }

  return (
    <dialog
      ref={dialogRef}
      className="album-dialog album-photo-edit-dialog"
      aria-labelledby={headingId}
      onClose={onClose}
      onClick={(event) => {
        if (event.target === event.currentTarget) dialogRef.current?.close();
      }}
    >
      <form
        className="album-dialog-surface album-form"
        onSubmit={(event: FormEvent<HTMLFormElement>) => {
          event.preventDefault();
          void onSave({ caption, altText, published });
        }}
      >
        <header className="album-dialog-header">
          <div>
            <p className="eyebrow">Photo {photo.id}</p>
            <h2 id={headingId}>编辑照片信息</h2>
          </div>
          <button
            className="album-icon-button"
            type="button"
            aria-label="关闭"
            onClick={() => dialogRef.current?.close()}
          >
            ×
          </button>
        </header>
        <label className="album-field">
          <span>说明</span>
          <textarea
            value={caption}
            onChange={(event) => setCaption(event.target.value)}
            maxLength={2000}
            rows={3}
            autoFocus
          />
        </label>
        <label className="album-field">
          <span>替代文本</span>
          <input
            value={altText}
            onChange={(event) => setAltText(event.target.value)}
            maxLength={500}
          />
          <small>请描述画面内容，方便使用读屏器的访客理解照片。</small>
        </label>
        <section
          className="album-manual-hdr"
          aria-labelledby={hdrHeadingId}
        >
          <header>
            <div>
              <p className="eyebrow">Photo version</p>
              <h3 id={hdrHeadingId}>
                {photo.hdrImage ? "替换 HDR 版本" : "手动配对 HDR"}
              </h3>
            </div>
            <span className={photo.hdrImage ? "is-paired" : ""}>
              {photo.hdrImage
                ? `${photo.hdrTransfer?.toUpperCase() || "HDR"} · ${
                    photo.hdrBitDepth || 10
                  }-bit`
                : "仅 SDR"}
            </span>
          </header>
          <p>
            直接选择这张照片对应的 HDR AVIF，文件名无需与 SDR
            一致。上传时仍会校验 PQ／HLG、10／12-bit 与画幅比例。
          </p>
          <input
            ref={hdrInputRef}
            className="visually-hidden"
            type="file"
            accept=".avif,image/avif"
            onChange={(event) => {
              setHdrFile(event.target.files?.[0] ?? null);
              setHdrError("");
              setHdrSuccess("");
              event.target.value = "";
            }}
          />
          <div className="album-manual-hdr-actions">
            <button
              className="album-action-button"
              type="button"
              disabled={busy}
              onClick={() => hdrInputRef.current?.click()}
            >
              {hdrFile ? "重新选择" : "选择 HDR AVIF"}
            </button>
            <span title={hdrFile?.name}>
              {hdrFile?.name ?? "适合手机端逐张选择，无需重命名"}
            </span>
            <button
              className="album-action-button album-action-button--primary"
              type="button"
              disabled={busy || !hdrFile}
              onClick={() => void uploadHdr()}
            >
              {hdrUploading
                ? `上传中 ${hdrProgress}%`
                : photo.hdrImage
                  ? "替换 HDR"
                  : "上传并配对"}
            </button>
          </div>
          {hdrUploading ? (
            <progress max={100} value={hdrProgress} />
          ) : null}
          {hdrError || hdrSuccess ? (
            <p
              className={hdrError ? "is-error" : "is-success"}
              role={hdrError ? "alert" : "status"}
            >
              {hdrError || hdrSuccess}
            </p>
          ) : null}
        </section>
        <label className="album-switch">
          <input
            type="checkbox"
            checked={published}
            onChange={(event) => setPublished(event.target.checked)}
          />
          <span>
            <strong>{published ? "公开照片" : "草稿照片"}</strong>
            <small>取消发布后，公开网格与灯箱会隐藏这张照片。</small>
          </span>
        </label>
        <button
          className="album-action-button album-action-button--primary album-submit"
          type="submit"
          disabled={busy}
        >
          {busy ? "保存中…" : "保存照片"}
        </button>
      </form>
    </dialog>
  );
}

type LightboxLayer = {
  key: string;
  photoId: number;
  range: PhotoRange;
  src: string;
  alt: string;
  /** incoming: loading/decoding out of sight; shown: the visible photo; outgoing: leaving. */
  role: "incoming" | "shown" | "outgoing";
};

type SwipeHandoff = {
  direction: 1 | -1;
  fromX: number;
  velocity: number;
  expires: number;
  layerKey: string;
};

type LayerTransition = {
  kind: "open" | "fade" | "crossfade" | "slide" | "cut";
  shown: string;
  outgoing: string | null;
  swipe?: SwipeHandoff;
};

/** Same threshold as the video player: quick loads never flash a hint. */
const LIGHTBOX_LOADING_DELAY_MS = 150;
/** The tile-to-photo morph only plays if the photo is ready this soon after opening. */
const OPEN_MORPH_BUDGET_MS = 320;
/** A committed swipe slides only if the next file is ready this soon; otherwise the photo returns. */
const SWIPE_HANDOFF_MS = 120;

function PhotoLightbox({
  token,
  photo,
  index,
  total,
  photos,
  onSelect,
  hdrFailed,
  failedHdrIds,
  onHdrFailure,
  onPrevious,
  onNext,
  onClose,
  findTile,
}: {
  token?: string;
  photo: GalleryPhoto;
  index: number;
  total: number;
  photos: GalleryPhoto[];
  onSelect: (index: number) => void;
  hdrFailed: boolean;
  failedHdrIds: ReadonlySet<number>;
  onHdrFailure: () => void;
  onPrevious: () => void;
  onNext: () => void;
  onClose: () => void;
  /** The grid tile image for a photo, used as the open/close morph anchor. */
  findTile: (photoId: number) => HTMLElement | null;
}) {
  const dialogRef = useRef<HTMLDialogElement>(null);
  const scrimRef = useRef<HTMLDivElement>(null);
  const stageRef = useRef<HTMLDivElement>(null);
  const closeButtonRef = useRef<HTMLButtonElement>(null);
  const activeThumbRef = useRef<HTMLButtonElement>(null);
  const railRef = useRef<HTMLElement>(null);
  const trackRef = useRef<HTMLOListElement>(null);
  // Imperative motion state. Gestures and animations never go through React state per frame.
  const layerElements = useRef(new Map<string, HTMLElement>());
  const layersRef = useRef<LightboxLayer[]>([]);
  const latestTargetRef = useRef("");
  const transitionRef = useRef<LayerTransition | null>(null);
  const motionRef = useRef<{ shell: Animation[]; layers: Animation[]; close: Animation[] }>({
    shell: [],
    layers: [],
    close: [],
  });
  // Returns must be iterable too: preference changes and unmount cancel every moving layer.
  const settleAnimations = useRef(new Map<HTMLElement, Animation[]>());
  const swipeRef = useRef<SwipeHandoff | null>(null);
  const swipeTimerRef = useRef<number | null>(null);
  const gestureActiveRef = useRef(false);
  const deferredPromotionRef = useRef<string | null>(null);
  const closingRef = useRef(false);
  const openedAtRef = useRef(0);
  const firstPhotoShownRef = useRef(false);
  const backdropAnimatableRef = useRef(false);
  const preloaderRef = useRef<ImagePreloader | null>(null);
  const propsRef = useRef({ onNext, onPrevious, findTile, total });

  const [hdrDisplay] = useState(
    () => typeof window !== "undefined" && Boolean(window.matchMedia?.("(dynamic-range: high)").matches),
  );
  // A manual version choice belongs to one photo; moving on starts from the preferred version.
  const [rangeChoice, setRangeChoice] = useState<{ photoId: number; range: PhotoRange } | null>(null);
  const [hlgFailedId, setHlgFailedId] = useState<number | null>(null);
  const hlgFailed = hlgFailedId === photo.id;
  const canUsePq = Boolean(photo.hdrUrl && !hdrFailed);
  const canUseHlg = Boolean(photo.hlgUrl && !hlgFailed);
  const preferredRange = preferredPhotoRange(photo, { hdrDisplay, pqFailed: hdrFailed, hlgFailed });
  const chosenRange = rangeChoice?.photoId === photo.id ? rangeChoice.range : null;
  const activeRange: PhotoRange =
    chosenRange === null ||
    (chosenRange === "PQ" && !canUsePq) ||
    (chosenRange === "HLG" && !canUseHlg)
      ? preferredRange
      : chosenRange;
  const source = photoRangeSource(photo, activeRange, { pqFailed: hdrFailed, hlgFailed });
  const alt = photo.altText || photo.caption || `相簿照片 ${index + 1}`;
  const targetKey = `${photo.id}:${activeRange}:${source}`;

  const [layers, setLayers] = useState<LightboxLayer[]>([]);
  const targetShown = layers.some((layer) => layer.key === targetKey && layer.role === "shown");
  const [loadingHint, setLoadingHint] = useState(false);

  useLayoutEffect(() => {
    propsRef.current = { onNext, onPrevious, findTile, total };
    latestTargetRef.current = targetKey;
  });

  const chromeElements = useCallback(
    () =>
      Array.from(
        dialogRef.current?.querySelectorAll<HTMLElement>(`.${CSS.escape(styles.chrome)}`) ?? [],
      ),
    [],
  );

  const clearSwipeTimer = useCallback(() => {
    if (swipeTimerRef.current !== null) window.clearTimeout(swipeTimerRef.current);
    swipeTimerRef.current = null;
  }, []);

  const cancelLayerMotion = useCallback(() => {
    motionRef.current.layers.forEach((animation) => animation.cancel());
    motionRef.current.layers = [];
  }, []);

  /** Tile morph for a rendered layer, or null when the morph would not read correctly. */
  const tileMorph = useCallback((element: HTMLElement, layer: LightboxLayer, drawn = IDENTITY_TRANSFORM) => {
    // HDR renditions are never morphed from/into an SDR thumbnail.
    if (layer.range !== "SDR") return null;
    const tile = propsRef.current.findTile(layer.photoId);
    const image = element.querySelector("img");
    if (!tile || !image) return null;
    const tileBox = tile.getBoundingClientRect();
    const photoBox = untransformedBox(image.getBoundingClientRect(), drawn);
    if (!boxIsVisible(tileBox, { width: window.innerWidth, height: window.innerHeight })) return null;
    if (!aspectsMatch(photoBox, tileBox)) return null;
    return flipTransform(photoBox, tileBox);
  }, []);

  /** Animate a dragged photo (and the receding chrome) back to rest. */
  const settleLayer = useCallback((layer: HTMLElement, from: LayerTransform) => {
    const dialog = dialogRef.current;
    if (!dialog) return;
    settleAnimations.current.get(layer)?.forEach((animation) => animation.cancel());
    settleAnimations.current.delete(layer);
    const tokens = readMotionTokens(dialog);
    const reduced = prefersReducedMotion();
    const faded = [scrimRef.current, ...chromeElements()].filter(
      (element): element is HTMLElement => Boolean(element),
    );
    const starts = faded.map((element) => getComputedStyle(element).opacity);
    const backdropStart = getComputedStyle(dialog, "::backdrop").opacity;
    layer.style.transform = "";
    dialog.style.removeProperty("--lb-dismiss");
    if (reduced) return;
    const options = { duration: tokens.media, easing: tokens.ease };
    const animations = [
      animateElement(layer, [{ transform: transformValue(from) }, { transform: "none" }], options),
      ...faded.map((element, i) =>
        starts[i] === "1" ? null : animateElement(element, [{ opacity: starts[i] }, { opacity: 1 }], options),
      ),
      backdropStart && backdropStart !== "1"
        ? animateElement(dialog, [{ opacity: backdropStart }, { opacity: 1 }], { ...options, pseudoElement: "::backdrop" })
        : null,
    ].filter((animation): animation is Animation => Boolean(animation));
    if (animations.length) {
      settleAnimations.current.set(layer, animations);
      void Promise.allSettled(animations.map((animation) => animation.finished)).then(() => {
        // A re-grab may already have replaced this layer's return animation.
        if (settleAnimations.current.get(layer) === animations) settleAnimations.current.delete(layer);
      });
    }
  }, [chromeElements]);

  const finishClose = useCallback(() => {
    const dialog = dialogRef.current;
    // The native close event runs onClose, which unmounts and restores focus.
    if (dialog?.open) dialog.close();
  }, []);

  /**
   * The one close path for Esc, the close button, a backdrop click, the platform
   * back/cancel request and pull-to-dismiss. A second request finishes at once.
   */
  const requestClose = useCallback((options: { from?: LayerTransform } = {}) => {
    const dialog = dialogRef.current;
    if (!dialog?.open) return;
    if (closingRef.current) {
      finishClose();
      return;
    }
    closingRef.current = true;
    dialog.dataset.closing = "true";
    clearSwipeTimer();
    swipeRef.current = null;

    const tokens = readMotionTokens(dialog);
    const reduced = prefersReducedMotion();
    const duration = reduced ? tokens.reduced : tokens.media;
    const shownLayer = layersRef.current.find((layer) => layer.role === "shown");
    const shown = shownLayer ? layerElements.current.get(shownLayer.key) ?? null : null;
    // Start every animation from what is drawn right now (mid-open, mid-drag or mid-settle).
    const from = options.from ?? (shown ? parseLayerTransform(getComputedStyle(shown).transform) : IDENTITY_TRANSFORM);
    const faded = [scrimRef.current, ...chromeElements()].filter(
      (element): element is HTMLElement => Boolean(element),
    );
    const fadedStarts = faded.map((element) => getComputedStyle(element).opacity);
    const backdropStart = getComputedStyle(dialog, "::backdrop").opacity || "1";
    const photoStart = shown ? getComputedStyle(shown).opacity : "1";
    // Closing can interrupt a crossfade or swipe: keep the departing photo at its drawn
    // position and fade it out too, instead of cancelling it back to fully opaque.
    const outgoing = layersRef.current
      .filter((layer) => layer.role === "outgoing")
      .flatMap((layer) => {
        const element = layerElements.current.get(layer.key);
        if (!element) return [];
        const style = getComputedStyle(element);
        return [{ element, opacity: style.opacity, transform: style.transform }];
      });
    motionRef.current.shell.forEach((animation) => animation.cancel());
    cancelLayerMotion();
    for (const animations of settleAnimations.current.values()) {
      animations.forEach((animation) => animation.cancel());
    }
    settleAnimations.current.clear();

    const fill = { duration, easing: tokens.ease, fill: "forwards" as const };
    const animations: Array<Animation | null> = [];
    const backdrop = animateElement(dialog, [{ opacity: backdropStart }, { opacity: 0 }], { ...fill, pseudoElement: "::backdrop" });
    animations.push(backdrop);
    // Without a fading backdrop the page stays hidden, so a morph would land on nothing.
    const morph = shown && shownLayer && !reduced && backdrop ? tileMorph(shown, shownLayer, from) : null;
    if (shown && morph) {
      animations.push(animateElement(
        shown,
        [{ transform: transformValue(from), opacity: photoStart }, { transform: transformValue(morph), opacity: 1 }],
        { ...fill, duration: tokens.media },
      ));
    } else if (shown) {
      // No reachable tile: a short fade, continuing a pull-down in its direction.
      const end = reduced ? {} : { transform: transformValue({ ...from, y: from.y + (from.y > 0 ? 48 : 0) }) };
      const start = reduced ? {} : { transform: transformValue(from) };
      animations.push(animateElement(shown, [{ ...start, opacity: photoStart }, { ...end, opacity: 0 }], fill));
    }
    faded.forEach((element, i) => {
      animations.push(animateElement(element, [{ opacity: fadedStarts[i] }, { opacity: 0 }], fill));
    });
    outgoing.forEach(({ element, opacity, transform }) => {
      animations.push(animateElement(element, [{ opacity, transform }, { opacity: 0, transform }], fill));
    });
    const running = animations.filter((animation): animation is Animation => Boolean(animation));
    motionRef.current.close = running;
    if (!running.length) {
      finishClose();
      return;
    }
    void Promise.allSettled(running.map((animation) => animation.finished)).then(() => {
      if (closingRef.current && motionRef.current.close === running) finishClose();
    });
  }, [cancelLayerMotion, chromeElements, clearSwipeTimer, finishClose, tileMorph]);

  /** Make a decoded incoming layer the visible photo, if it is still the latest request. */
  const promote = useCallback((key: string) => {
    if (key !== latestTargetRef.current || closingRef.current) return;
    if (gestureActiveRef.current) {
      // Never swap the photo under a finger; finish the swap when it lifts.
      deferredPromotionRef.current = key;
      return;
    }
    const current = layersRef.current;
    const incoming = current.find((layer) => layer.key === key && layer.role === "incoming");
    if (!incoming) return;
    const previous = current.find((layer) => layer.role === "shown") ?? null;
    const reduced = prefersReducedMotion();
    const swipe = swipeRef.current;
    let kind: LayerTransition["kind"];
    if (!previous) {
      kind = firstPhotoShownRef.current ? "fade" : "open";
    } else if (swipe && !reduced && previous.key === swipe.layerKey && performance.now() <= swipe.expires) {
      kind = "slide";
    } else {
      kind = photoChangeKind({ from: previous, to: incoming, reducedMotion: reduced });
    }
    firstPhotoShownRef.current = true;
    swipeRef.current = null;
    clearSwipeTimer();
    // Latest intent wins: an unfinished transition is dropped, not queued.
    cancelLayerMotion();
    const outgoing = previous && kind !== "cut" ? previous.key : null;
    transitionRef.current = { kind, shown: key, outgoing, swipe: kind === "slide" ? swipe ?? undefined : undefined };
    const next = current.flatMap((layer): LightboxLayer[] => {
      if (layer.key === key) return [{ ...layer, role: "shown" }];
      if (layer.key === outgoing) return [{ ...layer, role: "outgoing" }];
      return [];
    });
    layersRef.current = next;
    setLayers(next);
  }, [cancelLayerMotion, clearSwipeTimer]);

  const runLayerTransition = useCallback((plan: LayerTransition) => {
    const dialog = dialogRef.current;
    const shown = layerElements.current.get(plan.shown);
    const shownLayer = layersRef.current.find((layer) => layer.key === plan.shown);
    if (!dialog || !shown || !shownLayer) return;
    const tokens = readMotionTokens(dialog);
    const reduced = prefersReducedMotion();
    const outgoing = plan.outgoing ? layerElements.current.get(plan.outgoing) ?? null : null;
    const media = { duration: reduced ? tokens.reduced : tokens.media, easing: tokens.ease };
    const animations: Array<Animation | null> = [];
    const fadeIn = () => animateElement(shown, [{ opacity: 0 }, { opacity: 1 }], media);

    if (plan.kind === "open") {
      const morph =
        !reduced && backdropAnimatableRef.current && performance.now() - openedAtRef.current <= OPEN_MORPH_BUDGET_MS
          ? tileMorph(shown, shownLayer)
          : null;
      animations.push(morph
        ? animateElement(shown, [{ transform: transformValue(morph) }, { transform: "none" }], {
            duration: tokens.panel,
            easing: tokens.ease,
          })
        : fadeIn());
    } else if (plan.kind === "fade") {
      animations.push(fadeIn());
    } else if (plan.kind === "crossfade") {
      animations.push(fadeIn());
      animations.push(animateElement(outgoing, [{ opacity: 1 }, { opacity: 0 }], { ...media, fill: "forwards" }));
    } else if (plan.kind === "slide" && plan.swipe) {
      const { direction, fromX, velocity } = plan.swipe;
      const width = (stageRef.current?.clientWidth || dialog.clientWidth) + 24;
      const timing = {
        duration: swipeDuration(width - Math.abs(fromX), velocity, tokens.media, tokens.panel),
        easing: tokens.ease,
      };
      animations.push(animateElement(
        outgoing,
        [{ transform: `translate3d(${fromX}px, 0, 0)` }, { transform: `translate3d(${fromX - direction * width}px, 0, 0)` }],
        { ...timing, fill: "forwards" },
      ));
      animations.push(animateElement(
        shown,
        [{ transform: `translate3d(${fromX + direction * width}px, 0, 0)` }, { transform: "none" }],
        timing,
      ));
    }

    const running = animations.filter((animation): animation is Animation => Boolean(animation));
    const outgoingKey = plan.outgoing;
    const removeOutgoing = () => {
      if (!outgoingKey) return;
      setLayers((current) =>
        current.some((layer) => layer.key === outgoingKey && layer.role === "outgoing")
          ? current.filter((layer) => layer.key !== outgoingKey)
          : current,
      );
    };
    motionRef.current.layers = running;
    if (!running.length) {
      removeOutgoing();
      return;
    }
    void Promise.allSettled(running.map((animation) => animation.finished)).then(() => {
      // A newer promotion already removed what this transition was animating.
      if (motionRef.current.layers !== running) return;
      motionRef.current.layers = [];
      removeOutgoing();
    });
  }, [tileMorph]);

  // Open: native modal semantics first, then the surface fades in.
  useLayoutEffect(() => {
    const dialog = dialogRef.current;
    if (!dialog) return;
    if (!dialog.open) {
      dialog.showModal();
      // React's autoFocus runs before the dialog is open, so showModal() would pick the first
      // rail thumbnail; keep the intended initial focus on the close button.
      closeButtonRef.current?.focus({ preventScroll: true });
    }
    openedAtRef.current = performance.now();
    const tokens = readMotionTokens(dialog);
    const reduced = prefersReducedMotion();
    const options = { duration: reduced ? tokens.reduced : tokens.panel, easing: tokens.ease };
    const fadeIn = (element: Element | null, pseudoElement?: string) =>
      animateElement(element, [{ opacity: 0 }, { opacity: 1 }], { ...options, pseudoElement });
    const backdrop = fadeIn(dialog, "::backdrop");
    backdropAnimatableRef.current = Boolean(backdrop) || !(options.duration > 0);
    motionRef.current.shell = [backdrop, fadeIn(scrimRef.current), ...chromeElements().map((element) => fadeIn(element))]
      .filter((animation): animation is Animation => Boolean(animation));
    const motion = motionRef.current;
    return () => {
      motion.shell.forEach((animation) => animation.cancel());
      motion.layers.forEach((animation) => animation.cancel());
      motion.close.forEach((animation) => animation.cancel());
      for (const animations of settleAnimations.current.values()) {
        animations.forEach((animation) => animation.cancel());
      }
      settleAnimations.current.clear();
    };
  }, [chromeElements]);

  // A reduced-motion change cancels movement in flight; everything jumps to its end state.
  useEffect(() => {
    const query = window.matchMedia?.("(prefers-reduced-motion: reduce)");
    if (!query) return;
    const onChange = () => {
      if (!query.matches) return;
      const { shell, layers: running, close } = motionRef.current;
      const settling = [...settleAnimations.current.values()].flat();
      [...shell, ...running, ...close, ...settling].forEach((animation) => {
        try {
          animation.finish();
        } catch {
          animation.cancel();
        }
      });
    };
    query.addEventListener?.("change", onChange);
    return () => query.removeEventListener?.("change", onChange);
  }, []);

  // Each new target (photo or version) gets its own incoming layer; stale ones are dropped.
  useLayoutEffect(() => {
    setLayers((current) => {
      const shown = current.find((layer) => layer.role === "shown");
      if (shown?.key === targetKey) {
        return current.some((layer) => layer.role === "incoming")
          ? current.filter((layer) => layer.role !== "incoming")
          : current;
      }
      if (current.some((layer) => layer.key === targetKey && layer.role === "incoming")) return current;
      return [
        ...current.filter((layer) => layer.role !== "incoming" && layer.key !== targetKey),
        { key: targetKey, photoId: photo.id, range: activeRange, src: source, alt, role: "incoming" },
      ];
    });
  }, [targetKey]); // eslint-disable-line react-hooks/exhaustive-deps

  useLayoutEffect(() => {
    layersRef.current = layers;
    const plan = transitionRef.current;
    transitionRef.current = null;
    if (plan) runLayerTransition(plan);
    // A target that returns to a still-mounted rendition (e.g. back during its fade-out) reuses
    // an <img> that has already loaded, so no load event will come; promote it directly.
    const incoming = layers.find((layer) => layer.role === "incoming" && layer.key === latestTargetRef.current);
    const image = incoming ? layerElements.current.get(incoming.key)?.querySelector("img") : null;
    if (incoming && image?.getAttribute("src") && image.complete && image.naturalWidth > 0) {
      const key = incoming.key;
      void (image.decode?.() ?? Promise.resolve()).catch(() => {}).then(() => promote(key));
    }
  }, [layers, promote, runLayerTransition]);

  useEffect(() => {
    if (targetShown) {
      setLoadingHint(false);
      return;
    }
    const timer = window.setTimeout(() => setLoadingHint(true), LIGHTBOX_LOADING_DELAY_MS);
    return () => window.clearTimeout(timer);
  }, [targetKey, targetShown]);

  // Neighbour preloading: public assets only, after the current photo is on screen.
  useEffect(() => {
    // Protected (management) files must keep their authenticated fetch; no speculative copies.
    if (token !== undefined || !targetShown) return;
    const connection = (navigator as Navigator & { connection?: { saveData?: boolean; effectiveType?: string } })
      .connection;
    if (!canSpeculativelyPreload(connection)) return;
    const preloader = (preloaderRef.current ??= createImagePreloader({
      createImage: () => new Image() as unknown as PreloadImage,
    }));
    preloader.want(
      neighborIndices(index, photos.length).map((neighbor) => {
        const item = photos[neighbor];
        const pqFailed = failedHdrIds.has(item.id);
        return photoRangeSource(item, preferredPhotoRange(item, { hdrDisplay, pqFailed }), { pqFailed });
      }),
    );
  }, [failedHdrIds, hdrDisplay, index, photos, targetShown, token]);

  useEffect(() => () => {
    preloaderRef.current?.dispose();
    preloaderRef.current = null;
  }, []);

  useEffect(() => () => clearSwipeTimer(), [clearSwipeTimer]);

  // Single-finger gestures on the photo area: swipe to page, pull down to close.
  useEffect(() => {
    const stage = stageRef.current;
    const dialog = dialogRef.current;
    if (!stage || !dialog) return;
    type Gesture = {
      pointerId: number;
      startX: number;
      startY: number;
      base: LayerTransform;
      current: LayerTransform;
      axis: GestureAxis | null;
      layer: HTMLElement;
      layerKey: string;
    };
    const pointers = new Set<number>();
    const tracker = createVelocityTracker();
    let gesture: Gesture | null = null;
    // A second finger hands the touch sequence to the browser (pinch-zoom) until all lift.
    let blocked = false;
    let frame = 0;
    const viewport = window.visualViewport;

    const syncZoom = () => {
      stage.dataset.pageZoomed = String((viewport?.scale ?? 1) > 1.01);
    };
    const write = () => {
      frame = 0;
      if (!gesture) return;
      gesture.layer.style.transform = transformValue(gesture.current);
      dialog.style.setProperty("--lb-dismiss", String(dismissProgress(gesture.current.y, dialog.clientHeight)));
    };
    const schedule = () => {
      if (!frame) frame = requestAnimationFrame(write);
    };
    const flushDeferred = () => {
      const key = deferredPromotionRef.current;
      deferredPromotionRef.current = null;
      if (key) promote(key);
    };
    const end = () => {
      const ended = gesture;
      gesture = null;
      gestureActiveRef.current = false;
      if (frame) cancelAnimationFrame(frame);
      frame = 0;
      return ended;
    };
    const isRest = ({ x, y, scale }: LayerTransform) => x === 0 && y === 0 && scale === 1;

    /**
     * Grab the photo where it is drawn, interrupting a settle or a slide in flight. The photo
     * continues from there, but the new gesture is judged on its own finger travel only, so
     * catching a photo mid-animation never pages by itself.
     */
    const takeOver = (layer: HTMLElement) => {
      const drawn = parseLayerTransform(getComputedStyle(layer).transform);
      settleAnimations.current.get(layer)?.forEach((animation) => animation.cancel());
      settleAnimations.current.delete(layer);
      if (motionRef.current.layers.length) {
        cancelLayerMotion();
        setLayers((current) => current.filter((item) => item.role !== "outgoing"));
      }
      layer.style.transform = isRest(drawn) ? "" : transformValue(drawn);
      return drawn;
    };

    const onPointerDown = (event: PointerEvent) => {
      // Mouse users page with the buttons, rail and keyboard; drags would fight image selection.
      if (event.pointerType === "mouse") return;
      pointers.add(event.pointerId);
      if (pointers.size > 1) {
        blocked = true;
        const cancelled = end();
        if (cancelled && !isRest(cancelled.current)) settleLayer(cancelled.layer, cancelled.current);
        flushDeferred();
        return;
      }
      if (blocked || closingRef.current || !event.isPrimary) return;
      // A zoomed page keeps its own panning; the gesture would fight it.
      if ((viewport?.scale ?? 1) > 1.01) return;
      const shownLayer = layersRef.current.find((layer) => layer.role === "shown");
      const layer = shownLayer ? layerElements.current.get(shownLayer.key) : null;
      if (!shownLayer || !layer) return;
      if (swipeRef.current?.layerKey === shownLayer.key) {
        swipeRef.current = null;
        clearSwipeTimer();
      }
      const base = takeOver(layer);
      gesture = {
        pointerId: event.pointerId,
        startX: event.clientX,
        startY: event.clientY,
        base,
        current: base,
        axis: null,
        layer,
        layerKey: shownLayer.key,
      };
      gestureActiveRef.current = true;
      tracker.reset();
      tracker.add(event.timeStamp, event.clientX, event.clientY);
    };

    const onPointerMove = (event: PointerEvent) => {
      if (!gesture || event.pointerId !== gesture.pointerId) return;
      if (closingRef.current) {
        end();
        return;
      }
      tracker.add(event.timeStamp, event.clientX, event.clientY);
      const dx = event.clientX - gesture.startX;
      const dy = event.clientY - gesture.startY;
      if (gesture.axis === null) {
        const axis = lockGestureAxis(dx, dy, { canPage: propsRef.current.total > 1 });
        if (axis === null) return;
        if (axis === "none") {
          const rejected = end();
          if (rejected && !isRest(rejected.base)) settleLayer(rejected.layer, rejected.base);
          flushDeferred();
          return;
        }
        gesture.axis = axis;
        try {
          stage.setPointerCapture(event.pointerId);
        } catch {
          // Synthetic or already-released pointers cannot be captured; touch is implicitly captured.
        }
      }
      const { base } = gesture;
      if (gesture.axis === "x") {
        gesture.current = { ...base, x: base.x + axisOffset(dx) };
      } else {
        const y = Math.max(0, base.y + axisOffset(dy));
        gesture.current = { x: base.x, y, scale: dismissScale(dismissProgress(y, dialog.clientHeight)) };
      }
      schedule();
    };

    const release = (event: PointerEvent, cancelled: boolean) => {
      pointers.delete(event.pointerId);
      if (!pointers.size) blocked = false;
      if (!gesture || event.pointerId !== gesture.pointerId) return;
      const ended = end()!;
      if (ended.axis === null || ended.axis === "none" || cancelled) {
        if (!isRest(ended.current)) settleLayer(ended.layer, ended.current);
        flushDeferred();
        return;
      }
      ended.layer.style.transform = transformValue(ended.current);
      const velocity = tracker.velocity(event.timeStamp);
      const outcome = gestureOutcome({
        axis: ended.axis,
        offset: ended.axis === "x" ? ended.current.x - ended.base.x : ended.current.y - ended.base.y,
        velocity: ended.axis === "x" ? velocity.x : velocity.y,
        viewport: ended.axis === "x" ? stage.clientWidth : dialog.clientHeight,
      });
      if (outcome === "dismiss") {
        requestClose({ from: ended.current });
        return;
      }
      if (outcome === "return") {
        settleLayer(ended.layer, ended.current);
        flushDeferred();
        return;
      }
      const navigate = outcome === "next" ? propsRef.current.onNext : propsRef.current.onPrevious;
      dialog.style.removeProperty("--lb-dismiss");
      if (prefersReducedMotion()) {
        ended.layer.style.transform = "";
        deferredPromotionRef.current = null;
        navigate();
        return;
      }
      // Hold the photo where the finger left it; promote() slides the next one in if it is ready.
      const handoff: SwipeHandoff = {
        direction: outcome === "next" ? 1 : -1,
        fromX: ended.current.x,
        velocity: velocity.x,
        expires: performance.now() + SWIPE_HANDOFF_MS,
        layerKey: ended.layerKey,
      };
      swipeRef.current = handoff;
      clearSwipeTimer();
      swipeTimerRef.current = window.setTimeout(() => {
        swipeTimerRef.current = null;
        if (swipeRef.current !== handoff) return;
        swipeRef.current = null;
        // Not ready in time: return to centre and keep it until the next file decodes.
        const layer = layerElements.current.get(handoff.layerKey);
        if (layer && !closingRef.current) settleLayer(layer, { x: handoff.fromX, y: 0, scale: 1 });
      }, SWIPE_HANDOFF_MS);
      deferredPromotionRef.current = null;
      navigate();
    };
    const onPointerUp = (event: PointerEvent) => release(event, false);
    const onPointerCancel = (event: PointerEvent) => release(event, true);
    const onLostCapture = (event: PointerEvent) => {
      if (gesture?.axis && event.pointerId === gesture.pointerId) release(event, true);
    };

    syncZoom();
    viewport?.addEventListener("resize", syncZoom);
    stage.addEventListener("pointerdown", onPointerDown);
    stage.addEventListener("pointermove", onPointerMove);
    stage.addEventListener("lostpointercapture", onLostCapture);
    // Fingers can lift outside the photo area; track them wherever they end.
    window.addEventListener("pointerup", onPointerUp, true);
    window.addEventListener("pointercancel", onPointerCancel, true);
    return () => {
      viewport?.removeEventListener("resize", syncZoom);
      stage.removeEventListener("pointerdown", onPointerDown);
      stage.removeEventListener("pointermove", onPointerMove);
      stage.removeEventListener("lostpointercapture", onLostCapture);
      window.removeEventListener("pointerup", onPointerUp, true);
      window.removeEventListener("pointercancel", onPointerCancel, true);
      end();
    };
  }, [cancelLayerMotion, clearSwipeTimer, promote, requestClose, settleLayer]);

  // Slide the whole strip so the active thumbnail sits at the rail's center (vertical on desktop,
  // horizontal in the narrow-screen strip). The first placement is instant; later ones are animated by CSS.
  const centerActiveThumb = useCallback(() => {
    const rail = railRef.current;
    const track = trackRef.current;
    const item = activeThumbRef.current?.parentElement;
    if (!rail || !track || !item) return;
    const horizontal = window.matchMedia("(max-width: 900px)").matches;
    const offset = horizontal
      ? rail.clientWidth / 2 - (item.offsetLeft + item.offsetWidth / 2)
      : rail.clientHeight / 2 - (item.offsetTop + item.offsetHeight / 2);
    track.style.transform = horizontal
      ? `translate3d(${offset}px, 0, 0)`
      : `translate3d(0, ${offset}px, 0)`;
  }, []);

  useLayoutEffect(() => {
    centerActiveThumb();
    const track = trackRef.current;
    if (!track || track.classList.contains("is-animated")) return;
    const frame = requestAnimationFrame(() => track.classList.add("is-animated"));
    return () => cancelAnimationFrame(frame);
  }, [index, centerActiveThumb]);

  useEffect(() => {
    const rail = railRef.current;
    const track = trackRef.current;
    if (!rail || !track) return;
    const observer = new ResizeObserver(centerActiveThumb);
    observer.observe(rail);
    observer.observe(track);
    return () => observer.disconnect();
  }, [centerActiveThumb]);

  function onLayerError(layer: LightboxLayer) {
    // A stale request failing must not change the current photo's version.
    if (layer.key !== latestTargetRef.current) return;
    if (layer.range === "PQ" && layer.src === photo.hdrUrl) {
      onHdrFailure();
      setRangeChoice({ photoId: layer.photoId, range: canUseHlg ? "HLG" : "SDR" });
    } else if (layer.range === "HLG" && layer.src === photo.hlgUrl) {
      setHlgFailedId(layer.photoId);
      setRangeChoice({ photoId: layer.photoId, range: "SDR" });
    } else {
      // The SDR file itself failed: show its native broken state rather than the previous photo.
      promote(layer.key);
    }
  }

  return (
    <dialog
      ref={dialogRef}
      className={`album-lightbox ${styles.dialog}`}
      aria-label={`照片 ${index + 1} / ${total}`}
      onClose={onClose}
      onCancel={(event) => {
        // Platform close requests (Esc fallback, Android back) share the animated close.
        event.preventDefault();
        if (!closingRef.current) requestClose();
      }}
      onKeyDown={(event) => {
        if (closingRef.current && event.key !== "Escape") return;
        if (event.key === "ArrowLeft" || event.key === "ArrowUp") {
          event.preventDefault();
          onPrevious();
        } else if (event.key === "ArrowRight" || event.key === "ArrowDown") {
          event.preventDefault();
          onNext();
        } else if (event.key === "Escape") {
          event.preventDefault();
          requestClose();
        }
      }}
      onClick={(event) => {
        if (event.target === event.currentTarget || event.target === scrimRef.current) requestClose();
      }}
    >
      <div className={styles.scrim} ref={scrimRef} aria-hidden="true" />
      <div className={`album-lightbox-stage${total > 1 ? " has-rail" : ""} ${styles.content}`}>
        {total > 1 ? (
          <nav className={`album-lightbox-rail ${styles.chrome}`} aria-label="相簿照片预览" ref={railRef}>
            <ol ref={trackRef}>
              {photos.map((item, itemIndex) => (
                <li key={item.id}>
                  <button
                    ref={itemIndex === index ? activeThumbRef : undefined}
                    className={`album-rail-thumb${itemIndex === index ? " active" : ""}${
                      item.published ? "" : " is-draft"
                    }`}
                    type="button"
                    aria-label={`查看第 ${itemIndex + 1} 张照片`}
                    aria-current={itemIndex === index ? "true" : undefined}
                    onClick={() => onSelect(itemIndex)}
                  >
                    <AuthenticatedAssetImage
                      token={token}
                      src={item.thumbnailUrl}
                      srcSet={item.thumbnailSrcSet ?? undefined}
                      sizes="112px"
                      alt=""
                      width={item.width ?? undefined}
                      height={item.height ?? undefined}
                      loading="lazy"
                      decoding="async"
                    />
                    <span aria-hidden="true">
                      {String(itemIndex + 1).padStart(2, "0")}
                    </span>
                  </button>
                </li>
              ))}
            </ol>
          </nav>
        ) : null}
        <div className="album-lightbox-main">
        <header className={`album-lightbox-toolbar ${styles.chrome}`}>
          <span>
            {String(index + 1).padStart(2, "0")} /{" "}
            {String(total).padStart(2, "0")}
          </span>
          <div
            className="album-version-bar"
            role="group"
            aria-label="照片版本切换"
          >
            <button
              className={`album-version-button${
                activeRange === "SDR" ? " active" : ""
              }`}
              type="button"
              aria-pressed={activeRange === "SDR"}
              onClick={() => setRangeChoice({ photoId: photo.id, range: "SDR" })}
            >
              <span className="album-version-dot is-sdr" aria-hidden="true" />
              <span>
                SDR
                <small>标准范围</small>
              </span>
            </button>
            {photo.hdrImage ? (
              <button
                className={`album-version-button${
                  activeRange === "PQ" ? " active" : ""
                }`}
                type="button"
                aria-pressed={activeRange === "PQ"}
                disabled={!canUsePq}
                onClick={() => setRangeChoice({ photoId: photo.id, range: "PQ" })}
              >
                <span className="album-version-dot is-hdr" aria-hidden="true" />
                <span>
                  PQ
                  <small>
                    {hdrFailed
                      ? "载入失败"
                      : `${photo.hdrBitDepth || 10}-bit · 1000 nit`}
                  </small>
                </span>
              </button>
            ) : null}
            {photo.hlgImage ? (
              <button
                className={`album-version-button${
                  activeRange === "HLG" ? " active" : ""
                }`}
                type="button"
                aria-pressed={activeRange === "HLG"}
                disabled={!canUseHlg}
                onClick={() => setRangeChoice({ photoId: photo.id, range: "HLG" })}
              >
                <span className="album-version-dot is-hlg" aria-hidden="true" />
                <span>
                  HLG
                  <small>{hlgFailed ? "载入失败" : "10-bit · HDR 回退"}</small>
                </span>
              </button>
            ) : null}
          </div>
          <button
            ref={closeButtonRef}
            type="button"
            aria-label="关闭灯箱"
            autoFocus
            onClick={() => requestClose()}
          >
            关闭 <kbd>Esc</kbd>
          </button>
        </header>

        <figure aria-busy={loadingHint || undefined}>
          {/* Renditions stack in one cell: the shown photo stays until its replacement has decoded. */}
          <div className={styles.photoStage} ref={stageRef}>
            {layers.map((layer) => (
              <picture
                key={layer.key}
                className={styles.layer}
                data-role={layer.role}
                aria-hidden={layer.role === "shown" ? undefined : true}
                ref={(element) => {
                  if (element) layerElements.current.set(layer.key, element);
                  else layerElements.current.delete(layer.key);
                }}
              >
                <AuthenticatedAssetImage
                  token={token}
                  src={layer.src}
                  alt={layer.role === "shown" ? layer.alt : ""}
                  fetchPriority="high"
                  draggable={false}
                  onLoad={(event) => {
                    const image = event.currentTarget;
                    void (image.decode?.() ?? Promise.resolve())
                      .catch(() => {})
                      .then(() => promote(layer.key));
                  }}
                  onError={() => onLayerError(layer)}
                />
              </picture>
            ))}
            <span className={styles.loading} data-visible={loadingHint} aria-hidden="true">
              载入中
            </span>
          </div>
          <figcaption className={styles.chrome}>
            <p>{photo.caption || photo.altText || "未填写说明"}</p>
            {photo.filmStock ? (
              <small>
                {photo.filmStock} · {photo.filmProcess?.toUpperCase()} ·{" "}
                {formatFilmScanner(photo.filmScanner)}
              </small>
            ) : photo.hdrImage || photo.hlgImage ? (
              <small>
                当前：{activeRange} · HDR{" "}
                {photo.hdrPrimaries || "wide gamut"}
              </small>
            ) : (
              <small>SDR 原片</small>
            )}
          </figcaption>
        </figure>

        {total > 1 ? (
          <div className={`album-lightbox-navigation ${styles.chrome}`}>
            <button type="button" onClick={onPrevious} aria-label="上一张照片">
              <span aria-hidden="true">←</span>
              上一张
            </button>
            <button type="button" onClick={onNext} aria-label="下一张照片">
              下一张
              <span aria-hidden="true">→</span>
            </button>
          </div>
        ) : null}
        </div>
      </div>
    </dialog>
  );
}

function managedPhotoToGallery(photo: ManagedPhoto): GalleryPhoto {
  // Management refreshes use the same geometry and responsive assets as the public page.
  const dimensions =
    photo.width && photo.height
      ? { width: photo.width, height: photo.height }
      : null;
  return {
    id: photo.id,
    sdrImage: photo.sdrImage,
    hdrImage: photo.hdrImage,
    hlgImage: photo.hlgImage,
    thumbnailUrl: assetUrl(photo.sdrImage, "album-thumb")!,
    thumbnailSrcSet: albumThumbSrcSet(photo.sdrImage, dimensions),
    width: dimensions?.width ?? null,
    height: dimensions?.height ?? null,
    sdrUrl: `/api/assets/${photo.sdrImage}`,
    hdrUrl: photo.hdrImage ? `/api/assets/${photo.hdrImage}` : null,
    hlgUrl: photo.hlgImage ? `/api/assets/${photo.hlgImage}` : null,
    caption: photo.caption,
    altText: photo.altText,
    hdrTransfer: photo.hdrTransfer,
    hdrPrimaries: photo.hdrPrimaries,
    hdrBitDepth: photo.hdrBitDepth,
    filmStock: photo.filmStock,
    filmProcess: photo.filmProcess,
    filmScanner: photo.filmScanner,
    filmFrameFormat: photo.filmFrameFormat,
    published: photo.published,
    sortOrder: photo.sortOrder,
  };
}

function formatFilmScanner(scanner: string | null) {
  if (scanner === "hasselblad-x5") return "Hasselblad X5";
  if (scanner === "fujifilm-sp3000") return "Fujifilm SP-3000";
  if (scanner === "noritsu-hs1800") return "Noritsu HS-1800";
  return scanner || "胶片扫描";
}

function managedAlbumToGallery(album: ManagedAlbum): GalleryAlbum {
  return {
    id: album.id,
    title: album.title,
    slug: album.slug,
    description: album.description,
    coverImage: album.coverImage,
    published: album.published,
    photos: album.photos.map(managedPhotoToGallery),
  };
}

function ChevronIcon() {
  return (
    <svg
      className="action-menu-chevron"
      width="14"
      height="14"
      viewBox="0 0 24 24"
      fill="none"
      stroke="currentColor"
      strokeWidth="2"
      strokeLinecap="round"
      strokeLinejoin="round"
      aria-hidden="true"
    >
      <path d="m6 9 6 6 6-6" />
    </svg>
  );
}

function SlidersIcon() {
  return (
    <svg width="16" height="16" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2" strokeLinecap="round" aria-hidden="true">
      <path d="M4 6h7M15 6h5M4 12h3M11 12h9M4 18h10M18 18h2" />
      <circle cx="13" cy="6" r="2" />
      <circle cx="9" cy="12" r="2" />
      <circle cx="16" cy="18" r="2" />
    </svg>
  );
}
