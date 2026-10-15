"use client";

import {
  useEffect,
  useMemo,
  useRef,
  useState,
  type ChangeEvent,
  type DragEvent,
  type FormEvent,
} from "react";
import {
  pairAlbumFileSelections,
  uploadAlbumFormData,
} from "@/lib/album-management";

export type UploadMetadata = {
  caption: string;
  altText: string;
  published: boolean;
};


export const MAX_PHOTOS = 24;
export const MAX_FILE_BYTES = 64 * 1024 * 1024;
export const MAX_BATCH_BYTES = 512 * 1024 * 1024;


export function FileDropZone({
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

export function UploadPairEditor({
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


export function UploadIcon() {
  return (
    <svg width="18" height="18" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2" strokeLinecap="round" strokeLinejoin="round" aria-hidden="true">
      <path d="M12 16V4m0 0-4 4m4-4 4 4" />
      <path d="M4 15v4a1 1 0 0 0 1 1h14a1 1 0 0 0 1-1v-4" />
    </svg>
  );
}


/** Photo upload form bound to one already-authenticated album (used inside the album page). */
export function AlbumPhotoUploader({
  albumId,
  token,
  onUploaded,
  onClose,
}: {
  albumId: number;
  token: string;
  onUploaded: (message: string) => Promise<void> | void;
  onClose: () => void;
}) {
  const [sdrFiles, setSdrFiles] = useState<File[]>([]);
  const [hdrFiles, setHdrFiles] = useState<File[]>([]);
  const [metadata, setMetadata] = useState<Record<string, UploadMetadata>>({});
  const [busy, setBusy] = useState(false);
  const [progress, setProgress] = useState(0);
  const [error, setError] = useState("");
  const [success, setSuccess] = useState("");

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
    if (oversized) errors.push(`“${oversized.name}”超过 64 MiB。`);
    const totalBytes = allFiles.reduce((sum, file) => sum + file.size, 0);
    if (totalBytes > MAX_BATCH_BYTES) errors.push("本批文件总量超过 512 MiB。");
    return errors;
  }, [hdrFiles, pairing.errors, pairing.pairs.length, sdrFiles]);

  const hasSelection = sdrFiles.length > 0 || hdrFiles.length > 0;

  async function submit(event: FormEvent<HTMLFormElement>) {
    event.preventDefault();
    setError("");
    setSuccess("");
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
      setSdrFiles([]);
      setHdrFiles([]);
      setMetadata({});
      setSuccess(message);
      try {
        await onUploaded(message);
      } catch {
        // The upload is complete even if the follow-up refresh fails.
      }
    } catch (cause) {
      setError(cause instanceof Error ? cause.message : "上传照片失败。");
    } finally {
      setBusy(false);
    }
  }

  return (
    <form className="album-photo-uploader" onSubmit={submit}>
      <header className="album-photo-uploader-header">
        <div>
          <p className="eyebrow">上传照片</p>
          <h3>添加到此相簿</h3>
        </div>
        <button
          className="album-text-button"
          type="button"
          onClick={onClose}
          disabled={busy}
        >
          收起
        </button>
      </header>

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
          hint="可选 · 静态 10/12-bit PQ 或 HLG，需与 SDR 同名"
          accept=".avif,image/avif"
          files={hdrFiles}
          onFiles={setHdrFiles}
        />
      </div>

      {hasSelection && selectionErrors.length ? (
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
            <small>按去扩展名的文件名自动配对</small>
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
                  setMetadata((current) => ({ ...current, [pair.key]: next }))
                }
              />
            ))}
          </div>
        </section>
      ) : null}

      {error || success ? (
        <p
          className={`album-form-feedback${error ? " is-error" : " is-success"}`}
          role={error ? "alert" : "status"}
        >
          {error || success}
        </p>
      ) : null}
      {busy ? (
        <div className="album-progress" aria-live="polite">
          <progress max={100} value={progress} />
          <span>{progress}% · 正在上传并写入相簿</span>
        </div>
      ) : null}
      <button
        className="album-action-button album-action-button--primary album-submit"
        type="submit"
        disabled={busy || !pairing.pairs.length}
      >
        {busy ? "正在上传…" : "验证并上传"}
      </button>
    </form>
  );
}
