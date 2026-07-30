"use client";

import dynamic from "next/dynamic";
import { useRouter } from "next/navigation";
import {
  useEffect,
  useId,
  useMemo,
  useRef,
  useState,
  type ChangeEvent,
  type DragEvent,
  type FormEvent,
  type ReactNode,
} from "react";
import {
  albumApiRequest,
  fetchManagedAlbums,
  pairAlbumFileSelections,
  uploadAlbumFormData,
  type ManagedAlbum,
} from "@/lib/album-management";
import { ManagedAlbumGallery } from "@/components/AlbumGallery";

const FilmScanImport = dynamic(
  () =>
    import("@/components/FilmScanImport").then(
      (module) => module.FilmScanImport,
    ),
  {
    loading: () => <p className="album-inline-note">正在载入暗房审核工具…</p>,
  },
);

type AlbumOption = {
  id: number;
  title: string;
  slug: string;
  description: string;
  published: boolean;
};

type UploadMetadata = {
  caption: string;
  altText: string;
  published: boolean;
};

type AlbumDialogName = "create" | "upload" | "film" | "manage" | null;

const MAX_PHOTOS = 24;
const MAX_FILE_BYTES = 64 * 1024 * 1024;
const MAX_BATCH_BYTES = 512 * 1024 * 1024;

export function AlbumsToolbar({
  albums,
  initialDialog = null,
}: {
  albums: AlbumOption[];
  initialDialog?: AlbumDialogName;
}) {
  const router = useRouter();
  const [dialog, setDialog] = useState<AlbumDialogName>(initialDialog);
  const [token, setToken] = useState("");
  const [managedAlbums, setManagedAlbums] = useState<ManagedAlbum[] | null>(
    null,
  );
  const [loadingAlbums, setLoadingAlbums] = useState(false);
  const [notice, setNotice] = useState("");
  const [managedAlbumId, setManagedAlbumId] = useState<number | null>(null);

  async function loadManaged() {
    if (!token.trim()) {
      throw new Error("请输入管理员令牌。");
    }
    setLoadingAlbums(true);
    try {
      const nextAlbums = await fetchManagedAlbums(token);
      setManagedAlbums(nextAlbums);
      return nextAlbums;
    } finally {
      setLoadingAlbums(false);
    }
  }

  function completed(message: string) {
    setNotice(message);
    router.refresh();
  }

  function clearDialogQuery() {
    const url = new URL(window.location.href);
    if (!url.searchParams.has("dialog")) return;

    url.searchParams.delete("dialog");
    router.replace(`${url.pathname}${url.search}${url.hash}`, {
      scroll: false,
    });
  }

  function closeDialog() {
    setDialog(null);
    clearDialogQuery();
  }

  function updateManagedAlbum(updated: ManagedAlbum) {
    setManagedAlbums((current) =>
      current?.map((album) => (album.id === updated.id ? updated : album)) ?? [
        updated,
      ],
    );
  }

  const managedAlbum =
    managedAlbums?.find((album) => album.id === managedAlbumId) ?? null;

  return (
    <div className="album-toolbar">
      <div className="album-toolbar-actions" aria-label="相簿管理操作">
        <button
          className="album-action-button album-action-button--primary"
          type="button"
          onClick={() => setDialog("create")}
        >
          <PlusIcon />
          新建相簿
        </button>
        <button
          className="album-action-button"
          type="button"
          onClick={() => setDialog("upload")}
        >
          <UploadIcon />
          上传照片
        </button>
        <button
          className="album-action-button album-action-button--film"
          type="button"
          onClick={() => setDialog("film")}
        >
          <FilmIcon />
          导入胶片扫描
        </button>
      </div>

      <p className="album-toolbar-status" aria-live="polite">
        {notice}
      </p>

      {dialog === "create" ? (
        <AlbumModal title="新建相簿" onClose={closeDialog}>
          <CreateAlbumForm
            token={token}
            setToken={setToken}
            onCreated={(album) => {
              setManagedAlbums((current) =>
                current ? [album, ...current] : current,
              );
              completed(`相簿“${album.title}”已创建。`);
              closeDialog();
            }}
          />
        </AlbumModal>
      ) : null}

      {dialog === "upload" ? (
        <AlbumModal
          title="上传照片"
          onClose={closeDialog}
          wide
        >
          <UploadAlbumPhotosForm
            publicAlbums={albums}
            managedAlbums={managedAlbums}
            loadingAlbums={loadingAlbums}
            token={token}
            setToken={setToken}
            loadManaged={loadManaged}
            onManagedAlbums={setManagedAlbums}
            onCompleted={completed}
            onOpenManager={(albumId) => {
              clearDialogQuery();
              setManagedAlbumId(albumId);
              setDialog("manage");
            }}
          />
        </AlbumModal>
      ) : null}

      {dialog === "film" ? (
        <AlbumModal title="导入胶片扫描" onClose={closeDialog} wide>
          <FilmScanImport
            albums={(managedAlbums ?? albums).map((album) => ({
              id: album.id,
              title: album.title,
              published: album.published,
            }))}
            token={token}
            setToken={setToken}
            onCompleted={completed}
          />
        </AlbumModal>
      ) : null}

      {dialog === "manage" ? (
        <AlbumModal
          title="管理相簿"
          onClose={closeDialog}
          wide
        >
          {managedAlbum ? (
            <ManagedAlbumGallery
              key={managedAlbum.id}
              album={managedAlbum}
              token={token}
              onAlbumChange={updateManagedAlbum}
            />
          ) : (
            <p className="album-inline-note" role="status">
              管理相簿尚未载入，请返回“上传照片”并先验证管理员令牌。
            </p>
          )}
        </AlbumModal>
      ) : null}
    </div>
  );
}

function AlbumModal({
  title,
  children,
  onClose,
  wide = false,
}: {
  title: string;
  children: ReactNode;
  onClose: () => void;
  wide?: boolean;
}) {
  const dialogRef = useRef<HTMLDialogElement>(null);
  const headingId = useId();

  useEffect(() => {
    const dialog = dialogRef.current;
    if (dialog && !dialog.open) {
      dialog.showModal();
    }
  }, []);

  return (
    <dialog
      ref={dialogRef}
      className={`album-dialog${wide ? " album-dialog--wide" : ""}`}
      aria-labelledby={headingId}
      onClose={onClose}
      onClick={(event) => {
        if (event.target === event.currentTarget) {
          dialogRef.current?.close();
        }
      }}
    >
      <div className="album-dialog-surface">
        <header className="album-dialog-header">
          <div>
            <p className="eyebrow">暗房工作台</p>
            <h2 id={headingId}>{title}</h2>
          </div>
          <button
            className="album-icon-button"
            type="button"
            aria-label="关闭"
            onClick={() => dialogRef.current?.close()}
          >
            <CloseIcon />
          </button>
        </header>
        {children}
      </div>
    </dialog>
  );
}

function TokenField({
  token,
  setToken,
}: {
  token: string;
  setToken: (value: string) => void;
}) {
  return (
    <label className="album-field">
      <span>管理员令牌</span>
      <input
        type="password"
        value={token}
        onChange={(event) => setToken(event.target.value)}
        autoComplete="new-password"
        spellCheck={false}
        required
      />
      <small>仅保存在当前页面组件内，不会写入浏览器存储。</small>
    </label>
  );
}

function CreateAlbumForm({
  token,
  setToken,
  onCreated,
}: {
  token: string;
  setToken: (value: string) => void;
  onCreated: (album: ManagedAlbum) => void;
}) {
  const [title, setTitle] = useState("");
  const [slug, setSlug] = useState("");
  const [description, setDescription] = useState("");
  const [published, setPublished] = useState(true);
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState("");

  async function submit(event: FormEvent<HTMLFormElement>) {
    event.preventDefault();
    setError("");
    if (!token.trim()) {
      setError("请输入管理员令牌。");
      return;
    }
    setBusy(true);
    try {
      const response = await albumApiRequest<{
        status: string;
        album: ManagedAlbum;
      }>("/api/albums", token, {
        method: "POST",
        body: JSON.stringify({ title, slug: slug || undefined, description, published }),
      });
      onCreated(response.album);
    } catch (cause) {
      setError(cause instanceof Error ? cause.message : "创建相簿失败。");
    } finally {
      setBusy(false);
    }
  }

  return (
    <form className="album-form" onSubmit={submit}>
      <TokenField token={token} setToken={setToken} />
      <div className="album-form-grid">
        <label className="album-field">
          <span>标题</span>
          <input
            value={title}
            onChange={(event) => setTitle(event.target.value)}
            maxLength={200}
            autoFocus
            required
          />
        </label>
        <label className="album-field">
          <span>Slug（可选）</span>
          <input
            value={slug}
            onChange={(event) => setSlug(event.target.value.toLowerCase())}
            maxLength={200}
            pattern="[a-z0-9]+(?:-[a-z0-9]+)*"
            placeholder="night-walk"
          />
          <small>留空时从英文标题生成；无法生成时自动使用日期与短 ID。</small>
        </label>
      </div>
      <label className="album-field">
        <span>说明</span>
        <textarea
          value={description}
          onChange={(event) => setDescription(event.target.value)}
          maxLength={5000}
          rows={4}
        />
      </label>
      <label className="album-switch">
        <input
          type="checkbox"
          checked={published}
          onChange={(event) => setPublished(event.target.checked)}
        />
        <span>
          <strong>立即发布</strong>
          <small>关闭后保存为草稿，仅管理员列表可见。</small>
        </span>
      </label>
      <FormFeedback error={error} />
      <button
        className="album-action-button album-action-button--primary album-submit"
        type="submit"
        disabled={busy}
      >
        {busy ? "正在创建…" : published ? "创建并发布" : "保存草稿"}
      </button>
    </form>
  );
}

function UploadAlbumPhotosForm({
  publicAlbums,
  managedAlbums,
  loadingAlbums,
  token,
  setToken,
  loadManaged,
  onManagedAlbums,
  onCompleted,
  onOpenManager,
}: {
  publicAlbums: AlbumOption[];
  managedAlbums: ManagedAlbum[] | null;
  loadingAlbums: boolean;
  token: string;
  setToken: (value: string) => void;
  loadManaged: () => Promise<ManagedAlbum[]>;
  onManagedAlbums: (albums: ManagedAlbum[]) => void;
  onCompleted: (message: string) => void;
  onOpenManager: (albumId: number) => void;
}) {
  const options = managedAlbums ?? publicAlbums;
  const [albumId, setAlbumId] = useState(
    options[0] ? String(options[0].id) : "",
  );
  const [sdrFiles, setSdrFiles] = useState<File[]>([]);
  const [hdrFiles, setHdrFiles] = useState<File[]>([]);
  const [metadata, setMetadata] = useState<Record<string, UploadMetadata>>({});
  const [busy, setBusy] = useState(false);
  const [progress, setProgress] = useState(0);
  const [error, setError] = useState("");
  const [success, setSuccess] = useState("");
  const [showValidation, setShowValidation] = useState(false);

  useEffect(() => {
    if (!options.some((album) => String(album.id) === albumId)) {
      setAlbumId(options[0] ? String(options[0].id) : "");
    }
  }, [albumId, options]);

  const pairing = useMemo(
    () => pairAlbumFileSelections(sdrFiles, hdrFiles),
    [sdrFiles, hdrFiles],
  );

  useEffect(() => {
    setMetadata((current) => {
      const next: Record<string, UploadMetadata> = {};
      for (const pair of pairing.pairs) {
        next[pair.key] = current[pair.key] ?? {
          caption: "",
          altText: pair.key,
          published: true,
        };
      }
      return next;
    });
  }, [pairing.pairs]);

  const selectionErrors = useMemo(() => {
    const errors = [...pairing.errors];
    const allFiles = [...sdrFiles, ...hdrFiles];
    if (pairing.pairs.length > MAX_PHOTOS) {
      errors.push(`每批最多上传 ${MAX_PHOTOS} 张照片。`);
    }
    const oversized = allFiles.find((file) => file.size > MAX_FILE_BYTES);
    if (oversized) {
      errors.push(`“${oversized.name}”超过 64 MiB。`);
    }
    const totalBytes = allFiles.reduce((sum, file) => sum + file.size, 0);
    if (totalBytes > MAX_BATCH_BYTES) {
      errors.push("本批文件总量超过 512 MiB。");
    }
    return errors;
  }, [hdrFiles, pairing.errors, pairing.pairs.length, sdrFiles]);

  const selectedManagedAlbum = managedAlbums?.find(
    (album) => String(album.id) === albumId,
  );

  async function revealManagedAlbums() {
    setError("");
    try {
      const loaded = await loadManaged();
      if (!albumId && loaded[0]) {
        setAlbumId(String(loaded[0].id));
      }
    } catch (cause) {
      setError(cause instanceof Error ? cause.message : "加载相簿失败。");
    }
  }

  async function submit(event: FormEvent<HTMLFormElement>) {
    event.preventDefault();
    setShowValidation(true);
    setError("");
    setSuccess("");

    if (!token.trim()) {
      setError("请输入管理员令牌。");
      return;
    }
    if (!albumId) {
      setError("请先选择或新建一个相簿。");
      return;
    }
    if (selectionErrors.length) {
      setError("请先修正文件配对与容量问题。");
      return;
    }

    const formData = new FormData();
    formData.append(
      "manifest",
      JSON.stringify({
        photos: pairing.pairs.map((pair) => ({
          key: pair.key,
          ...(metadata[pair.key] ?? {
            caption: "",
            altText: pair.key,
            published: true,
          }),
        })),
      }),
    );
    for (const file of sdrFiles) formData.append("sdrFiles", file, file.name);
    for (const file of hdrFiles) formData.append("hdrFiles", file, file.name);

    setBusy(true);
    setProgress(0);
    try {
      await uploadAlbumFormData(
        `/api/albums/${albumId}/photos`,
        token,
        formData,
        setProgress,
      );
      const message = `已上传 ${pairing.pairs.length} 张照片，其中 ${
        pairing.pairs.filter((pair) => pair.hdr).length
      } 张带 HDR。`;
      setSuccess(message);
      setSdrFiles([]);
      setHdrFiles([]);
      setMetadata({});
      setShowValidation(false);
      try {
        onManagedAlbums(await loadManaged());
      } catch {
        // The upload is complete even if the optional management refresh fails.
      }
      onCompleted(message);
    } catch (cause) {
      setError(cause instanceof Error ? cause.message : "上传照片失败。");
    } finally {
      setBusy(false);
    }
  }

  return (
    <form className="album-form album-upload-form" onSubmit={submit}>
      <section className="album-upload-context" aria-label="上传目标">
        <TokenField token={token} setToken={setToken} />
        <div className="album-target-row">
          <label className="album-field">
            <span>目标相簿</span>
            <select
              value={albumId}
              onChange={(event) => setAlbumId(event.target.value)}
              disabled={!options.length}
              required
            >
              {!options.length ? <option value="">暂无相簿</option> : null}
              {options.map((album) => (
                <option value={album.id} key={album.id}>
                  {album.title}
                  {!album.published ? "（草稿）" : ""}
                </option>
              ))}
            </select>
          </label>
          <button
            className="album-text-button"
            type="button"
            disabled={loadingAlbums || !token.trim()}
            onClick={revealManagedAlbums}
          >
            {loadingAlbums ? "正在验证…" : "验证令牌并加载草稿"}
          </button>
        </div>
        {!options.length ? (
          <p className="album-inline-note">请先关闭弹窗并新建相簿。</p>
        ) : null}
      </section>

      {selectedManagedAlbum ? (
        <div className="album-managed-selection">
          <AlbumSettings
            key={selectedManagedAlbum.id}
            album={selectedManagedAlbum}
            token={token}
            onSaved={async () => {
              onManagedAlbums(await loadManaged());
              onCompleted("相簿设置已更新。");
            }}
          />
          <button
            className="album-action-button"
            type="button"
            onClick={() => onOpenManager(selectedManagedAlbum.id)}
          >
            管理照片、封面与顺序
          </button>
        </div>
      ) : null}

      <div className="album-drop-grid">
        <FileDropZone
          label="SDR 照片"
          hint="必选 · JPEG / PNG / WebP / 非 HDR AVIF"
          accept=".jpg,.jpeg,.png,.webp,.avif,image/jpeg,image/png,image/webp,image/avif"
          files={sdrFiles}
          onFiles={setSdrFiles}
        />
        <FileDropZone
          label="HDR AVIF"
          hint="可选 · 静态 10/12-bit PQ 或 HLG"
          accept=".avif,image/avif"
          files={hdrFiles}
          onFiles={setHdrFiles}
        />
      </div>

      {(showValidation || sdrFiles.length > 0 || hdrFiles.length > 0) &&
      selectionErrors.length ? (
        <div className="album-error-list" role="alert">
          <strong>本批次尚不能上传</strong>
          <ul>
            {selectionErrors.map((message, index) => (
              <li key={`${message}-${index}`}>{message}</li>
            ))}
          </ul>
        </div>
      ) : null}

      {pairing.pairs.length ? (
        <section className="album-pairing">
          <header>
            <div>
              <p className="eyebrow">同名配对预览</p>
              <h3>
                {pairing.pairs.length} 张 SDR ·{" "}
                {pairing.pairs.filter((pair) => pair.hdr).length} 组 HDR
              </h3>
            </div>
            <small>
              优先按去扩展名的文件名自动配对；名称不同可在管理模式中逐张手动补传
            </small>
          </header>
          <div className="album-pair-list">
            {pairing.pairs.map((pair) => (
              <UploadPairEditor
                key={pair.key}
                pair={pair}
                value={
                  metadata[pair.key] ?? {
                    caption: "",
                    altText: pair.key,
                    published: true,
                  }
                }
                onChange={(next) =>
                  setMetadata((current) => ({
                    ...current,
                    [pair.key]: next,
                  }))
                }
              />
            ))}
          </div>
        </section>
      ) : null}

      <FormFeedback error={error} success={success} />
      {busy ? (
        <div className="album-progress" aria-live="polite">
          <progress max={100} value={progress} />
          <span>{progress}% · 正在上传并写入相簿</span>
        </div>
      ) : null}
      <button
        className="album-action-button album-action-button--primary album-submit"
        type="submit"
        disabled={busy || !options.length}
      >
        {busy ? "正在上传…" : "验证并上传整批照片"}
      </button>
    </form>
  );
}

function AlbumSettings({
  album,
  token,
  onSaved,
}: {
  album: ManagedAlbum;
  token: string;
  onSaved: () => Promise<void>;
}) {
  const [title, setTitle] = useState(album.title);
  const [description, setDescription] = useState(album.description);
  const [published, setPublished] = useState(album.published);
  const [busy, setBusy] = useState(false);
  const [message, setMessage] = useState("");

  async function save() {
    setBusy(true);
    setMessage("");
    try {
      await albumApiRequest(`/api/albums/${album.id}`, token, {
        method: "PATCH",
        body: JSON.stringify({ title, description, published }),
      });
      await onSaved();
      setMessage("设置已保存。");
    } catch (cause) {
      setMessage(cause instanceof Error ? cause.message : "保存失败。");
    } finally {
      setBusy(false);
    }
  }

  return (
    <details className="album-settings">
      <summary>编辑所选相簿设置</summary>
      <div className="album-settings-body">
        <div className="album-form-grid">
          <label className="album-field">
            <span>标题</span>
            <input
              value={title}
              onChange={(event) => setTitle(event.target.value)}
              maxLength={200}
              required
            />
          </label>
          <label className="album-field">
            <span>Slug（创建后只读）</span>
            <input value={album.slug} readOnly />
          </label>
        </div>
        <label className="album-field">
          <span>说明</span>
          <textarea
            value={description}
            onChange={(event) => setDescription(event.target.value)}
            maxLength={5000}
            rows={3}
          />
        </label>
        <div className="album-settings-footer">
          <label className="album-switch album-switch--compact">
            <input
              type="checkbox"
              checked={published}
              onChange={(event) => setPublished(event.target.checked)}
            />
            <span>
              <strong>{published ? "已发布" : "草稿"}</strong>
            </span>
          </label>
          <button
            className="album-text-button"
            type="button"
            disabled={busy || !title.trim()}
            onClick={save}
          >
            {busy ? "保存中…" : "保存相簿设置"}
          </button>
        </div>
        <p className="album-inline-note" aria-live="polite">
          {message}
        </p>
      </div>
    </details>
  );
}

function FileDropZone({
  label,
  hint,
  accept,
  files,
  onFiles,
}: {
  label: string;
  hint: string;
  accept: string;
  files: File[];
  onFiles: (files: File[]) => void;
}) {
  const inputRef = useRef<HTMLInputElement>(null);
  const [dragging, setDragging] = useState(false);

  function select(event: ChangeEvent<HTMLInputElement>) {
    onFiles(Array.from(event.target.files ?? []));
    event.target.value = "";
  }

  function drop(event: DragEvent<HTMLDivElement>) {
    event.preventDefault();
    setDragging(false);
    onFiles(Array.from(event.dataTransfer.files));
  }

  return (
    <div
      className={`album-drop-zone${dragging ? " is-dragging" : ""}`}
      onDragEnter={(event) => {
        event.preventDefault();
        setDragging(true);
      }}
      onDragOver={(event) => event.preventDefault()}
      onDragLeave={(event) => {
        if (!event.currentTarget.contains(event.relatedTarget as Node | null)) {
          setDragging(false);
        }
      }}
      onDrop={drop}
    >
      <input
        ref={inputRef}
        className="visually-hidden"
        type="file"
        accept={accept}
        multiple
        onChange={select}
      />
      <div className="album-drop-icon" aria-hidden="true">
        <UploadIcon />
      </div>
      <strong>{label}</strong>
      <span>{hint}</span>
      <button
        className="album-text-button"
        type="button"
        onClick={() => inputRef.current?.click()}
      >
        选择文件
      </button>
      <small>
        {files.length
          ? `已选择 ${files.length} 个文件`
          : "拖放到此处，或使用文件选择器"}
      </small>
    </div>
  );
}

function UploadPairEditor({
  pair,
  value,
  onChange,
}: {
  pair: {
    key: string;
    sdr: File;
    hdr: File | null;
  };
  value: UploadMetadata;
  onChange: (value: UploadMetadata) => void;
}) {
  const [preview, setPreview] = useState("");

  useEffect(() => {
    const url = URL.createObjectURL(pair.sdr);
    setPreview(url);
    return () => URL.revokeObjectURL(url);
  }, [pair.sdr]);

  return (
    <article className="album-pair-row">
      <div className="album-pair-preview">
        {preview ? <img src={preview} alt="" /> : null}
        <span className={pair.hdr ? "is-hdr" : ""}>
          {pair.hdr ? "HDR 配对" : "SDR"}
        </span>
      </div>
      <div className="album-pair-copy">
        <strong>{pair.sdr.name}</strong>
        <small>{pair.hdr?.name ?? "无 HDR 文件"}</small>
      </div>
      <label className="album-field">
        <span>说明</span>
        <input
          value={value.caption}
          onChange={(event) =>
            onChange({ ...value, caption: event.target.value })
          }
          maxLength={2000}
        />
      </label>
      <label className="album-field">
        <span>替代文本</span>
        <input
          value={value.altText}
          onChange={(event) =>
            onChange({ ...value, altText: event.target.value })
          }
          maxLength={500}
        />
      </label>
      <label className="album-switch album-switch--compact">
        <input
          type="checkbox"
          checked={value.published}
          onChange={(event) =>
            onChange({ ...value, published: event.target.checked })
          }
        />
        <span>
          <strong>{value.published ? "发布" : "草稿"}</strong>
        </span>
      </label>
    </article>
  );
}

function FormFeedback({
  error,
  success,
}: {
  error?: string;
  success?: string;
}) {
  if (!error && !success) return null;
  return (
    <p
      className={`album-form-feedback${error ? " is-error" : " is-success"}`}
      role={error ? "alert" : "status"}
    >
      {error || success}
    </p>
  );
}

function PlusIcon() {
  return (
    <svg width="16" height="16" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2" strokeLinecap="round" aria-hidden="true">
      <path d="M12 5v14M5 12h14" />
    </svg>
  );
}

function UploadIcon() {
  return (
    <svg width="18" height="18" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2" strokeLinecap="round" strokeLinejoin="round" aria-hidden="true">
      <path d="M12 16V4m0 0-4 4m4-4 4 4" />
      <path d="M4 15v4a1 1 0 0 0 1 1h14a1 1 0 0 0 1-1v-4" />
    </svg>
  );
}

function FilmIcon() {
  return (
    <svg width="18" height="18" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="1.8" strokeLinecap="round" strokeLinejoin="round" aria-hidden="true">
      <rect x="3" y="5" width="18" height="14" rx="2" />
      <path d="M7 5v14M17 5v14M3 9h4M3 15h4M17 9h4M17 15h4" />
      <circle cx="12" cy="12" r="2.8" />
    </svg>
  );
}

function CloseIcon() {
  return (
    <svg width="18" height="18" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2" strokeLinecap="round" aria-hidden="true">
      <path d="m6 6 12 12M18 6 6 18" />
    </svg>
  );
}
