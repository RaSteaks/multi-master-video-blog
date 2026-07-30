"use client";

import Link from "next/link";
import { useRouter } from "next/navigation";
import {
  useEffect,
  useId,
  useMemo,
  useRef,
  useState,
  type FormEvent,
  type MouseEvent,
} from "react";
import {
  albumApiRequest,
  fetchManagedAlbums,
  uploadAlbumFormData,
  type ManagedAlbum,
  type ManagedPhoto,
} from "@/lib/album-management";

export type GalleryPhoto = {
  id: number;
  sdrImage: string;
  hdrImage: string | null;
  hlgImage: string | null;
  thumbnailUrl: string;
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
  const [adminOpen, setAdminOpen] = useState(Boolean(initialManagedAlbum));
  const [token, setToken] = useState(initialToken);
  const [managedAlbum, setManagedAlbum] = useState<ManagedAlbum | null>(
    initialManagedAlbum,
  );
  const [adminBusy, setAdminBusy] = useState(false);
  const [adminError, setAdminError] = useState("");
  const [adminNotice, setAdminNotice] = useState("");
  const [orderDirty, setOrderDirty] = useState(false);
  const [editingPhoto, setEditingPhoto] = useState<ManagedPhoto | null>(null);
  const [lightboxIndex, setLightboxIndex] = useState<number | null>(null);
  const [failedHdr, setFailedHdr] = useState<Set<number>>(() => new Set());
  const lastTrigger = useRef<HTMLButtonElement | null>(null);

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

  async function loadAdminAlbum() {
    if (!token.trim()) {
      setAdminError("请输入管理员令牌。");
      return null;
    }
    setAdminBusy(true);
    setAdminError("");
    try {
      const albums = await fetchManagedAlbums(token);
      const album = albums.find((item) => item.id === initialAlbum.id);
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
    const albums = await fetchManagedAlbums(token);
    const album = albums.find((item) => item.id === initialAlbum.id);
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

  function toggleAdmin() {
    if (adminOpen) {
      setAdminOpen(false);
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
    window.setTimeout(() => lastTrigger.current?.focus(), 0);
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
      className={`${embedded ? "album-manager-workspace " : "shell page-stack "}album-detail`}
    >
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
          {!embedded ? (
            <button
              className="album-action-button"
              type="button"
              aria-expanded={adminOpen}
              aria-controls="album-admin-panel"
              onClick={toggleAdmin}
            >
              <SlidersIcon />
              {adminOpen ? "退出管理" : "管理模式"}
            </button>
          ) : null}
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
              <label className="album-field">
                <span>管理员令牌</span>
                <input
                  type="password"
                  value={token}
                  onChange={(event) => setToken(event.target.value)}
                  autoComplete="new-password"
                  autoFocus
                  required
                />
              </label>
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
                className={`${index % 7 === 0 ? "is-featured " : ""}${
                  !photo.published ? "is-draft" : ""
                }`}
                key={photo.id}
              >
                <article className="album-photo-tile">
                  <button
                    className="album-photo-open"
                    type="button"
                    onClick={(event) => openLightbox(index, event)}
                    aria-label={`查看第 ${index + 1} 张照片${
                      photo.caption ? `：${photo.caption}` : ""
                    }`}
                  >
                    <img
                      src={photo.thumbnailUrl}
                      alt={photo.altText || ""}
                      loading="lazy"
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
            <p>返回相簿页，从标题区的“上传照片”加入第一批照片。</p>
          </div>
        </section>
      )}

      {selectedPhoto && lightboxIndex !== null ? (
        <PhotoLightbox
          photo={selectedPhoto}
          index={lightboxIndex}
          total={photos.length}
          hdrFailed={failedHdr.has(selectedPhoto.id)}
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

function PhotoLightbox({
  photo,
  index,
  total,
  hdrFailed,
  onHdrFailure,
  onPrevious,
  onNext,
  onClose,
}: {
  photo: GalleryPhoto;
  index: number;
  total: number;
  hdrFailed: boolean;
  onHdrFailure: () => void;
  onPrevious: () => void;
  onNext: () => void;
  onClose: () => void;
}) {
  const dialogRef = useRef<HTMLDialogElement>(null);
  const [activeRange, setActiveRange] = useState<"PQ" | "HLG" | "SDR">("SDR");
  const [hlgFailed, setHlgFailed] = useState(false);
  const canUsePq = Boolean(photo.hdrUrl && !hdrFailed);
  const canUseHlg = Boolean(photo.hlgUrl && !hlgFailed);

  useEffect(() => {
    const dialog = dialogRef.current;
    if (dialog && !dialog.open) dialog.showModal();
  }, []);

  useEffect(() => {
    const prefersHdr = window.matchMedia("(dynamic-range: high)").matches;
    setHlgFailed(false);
    setActiveRange(
      prefersHdr && canUsePq ? "PQ" : prefersHdr && photo.hlgUrl ? "HLG" : "SDR",
    );
  }, [canUsePq, photo.hlgUrl, photo.id]);

  return (
    <dialog
      ref={dialogRef}
      className="album-lightbox"
      aria-label={`照片 ${index + 1} / ${total}`}
      onClose={onClose}
      onKeyDown={(event) => {
        if (event.key === "ArrowLeft") {
          event.preventDefault();
          onPrevious();
        } else if (event.key === "ArrowRight") {
          event.preventDefault();
          onNext();
        } else if (event.key === "Escape") {
          event.preventDefault();
          dialogRef.current?.close();
        }
      }}
      onClick={(event) => {
        if (event.target === event.currentTarget) dialogRef.current?.close();
      }}
    >
      <div className="album-lightbox-stage">
        <header className="album-lightbox-toolbar">
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
              onClick={() => setActiveRange("SDR")}
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
                onClick={() => setActiveRange("PQ")}
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
                onClick={() => setActiveRange("HLG")}
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
            type="button"
            aria-label="关闭灯箱"
            autoFocus
            onClick={() => dialogRef.current?.close()}
          >
            关闭 <kbd>Esc</kbd>
          </button>
        </header>

        <figure>
          <picture>
            <img
              key={`${photo.id}-${activeRange}`}
              src={
                activeRange === "PQ" && canUsePq
                  ? photo.hdrUrl!
                  : activeRange === "HLG" && canUseHlg
                    ? photo.hlgUrl!
                  : photo.sdrUrl
              }
              alt={photo.altText || photo.caption || `相簿照片 ${index + 1}`}
              fetchPriority="high"
              onError={() => {
                if (activeRange === "PQ") {
                  onHdrFailure();
                  setActiveRange(canUseHlg ? "HLG" : "SDR");
                } else if (activeRange === "HLG") {
                  setHlgFailed(true);
                  setActiveRange("SDR");
                }
              }}
            />
          </picture>
          <figcaption>
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
          <div className="album-lightbox-navigation">
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
    </dialog>
  );
}

function managedPhotoToGallery(photo: ManagedPhoto): GalleryPhoto {
  return {
    id: photo.id,
    sdrImage: photo.sdrImage,
    hdrImage: photo.hdrImage,
    hlgImage: photo.hlgImage,
    thumbnailUrl: `/api/assets/${photo.sdrImage}?key=album-thumb`,
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
