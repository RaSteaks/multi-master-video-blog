"use client";

import { FormEvent, useMemo, useRef, useState } from "react";
import type { Lang } from "@/components/UploadPageClient";

type UploadState = "idle" | "uploading" | "success" | "error";
type SourceKind = "embedded" | "master_package" | "hls_package";

type UploadResponse = {
  status: string;
  hlsUrl?: string;
  colorContract?: {
    displayGamutLabel?: string | null;
    colorPrimaries?: string | null;
    colorTransfer?: string | null;
    hlsVideoRange?: string | null;
  };
  verification?: {
    status?: string;
    verifiedAt?: string;
  };
  sourceKind?: SourceKind;
  masterPackage?: {
    fileCount: number;
    sourceFile: string;
    sidecarCount: number;
  } | null;
  project?: {
    slug?: string;
  };
  error?: string;
};

type DirectoryInputProps = {
  webkitdirectory: "";
  directory: "";
};

const masterTypes = [
  { label: "SDR", value: "sdr" },
  { label: "HDR10", value: "hdr10" },
  { label: "HLG", value: "hlg" },
  { label: "Dolby Vision", value: "dolby_vision" },
  { label: "Custom", value: "custom" },
];

const translations = {
  en: {
    access: "Access",
    uploadToken: "Upload token",
    source: "Source",
    videoSourceType: "Video source type",
    sourceVideo: "Source video",
    completeHlsFolder: "Complete HLS package folder",
    completeMasterFolder: "Complete master package folder",
    xmlClipName: "XML clip name",
    xmlClipNamePlaceholder: "Optional clip/shot name inside Dolby XML",
    coverImage: "Cover image",
    sourceStreamNote: "Source stream metadata is preserved by default.",
    metadata: "Metadata",
    titleLabel: "Title",
    slug: "Slug",
    tags: "Tags",
    tagsPlaceholder: "dolby, hdr, test",
    description: "Description",
    master: "Master",
    masterType: "Master type",
    labelField: "Label",
    hlsMode: "HLS mode",
    copySourceStream: "Copy source stream",
    transcodeSdr: "Transcode SDR derivative",
    notes: "Notes",
    published: "Published",
    defaultMaster: "Default master",
    overwriteHls: "Overwrite existing HLS",
    uploading: "Uploading...",
    uploadVideo: "Upload Video",
    uploadComplete: "Upload complete. Metadata was detected by the server.",
    uploadingMessage: "Uploading and scanning source metadata...",
    networkError: "Upload failed before the server responded.",
    openVideoPage: "Open video page",
    hlsSelectFolder: "Select the complete HLS package folder.",
    dvSelectFolder: "Select the complete Dolby Vision package folder.",
    filesSelected: (n: number) => `${n} files selected`,
    httpError: (status: number) => `Upload failed with HTTP ${status}.`,
    dropDrag: "Drag & drop, or",
    dropBrowse: "browse files",
    dropRelease: "Release to upload",
    sourceModes: [
      {
        value: "embedded" as SourceKind,
        title: "Embedded MP4 / MOV",
        detail:
          "Upload a browser-deliverable video. Dolby Vision is detected from embedded DOVI/RPU stream metadata.",
      },
      {
        value: "master_package" as SourceKind,
        title: "DV Master / IMF / ProRes Package",
        detail:
          "Upload the full folder/package. XML sidecars, RPU files, MXF, IMF, and primary essence are scanned together.",
      },
      {
        value: "hls_package" as SourceKind,
        title: "Verified HLS Package",
        detail:
          "Upload a complete HLS folder. The master playlist must include VIDEO-RANGE and all variants must share one color contract.",
      },
    ],
  },
  zh: {
    access: "访问凭证",
    uploadToken: "上传令牌",
    source: "源文件",
    videoSourceType: "视频源类型",
    sourceVideo: "源视频",
    completeHlsFolder: "完整 HLS 包文件夹",
    completeMasterFolder: "完整母版包文件夹",
    xmlClipName: "XML 片段名称",
    xmlClipNamePlaceholder: "Dolby XML 内的可选片段/镜头名称",
    coverImage: "封面图片",
    sourceStreamNote: "默认保留源流元数据。",
    metadata: "元数据",
    titleLabel: "标题",
    slug: "Slug",
    tags: "标签",
    tagsPlaceholder: "dolby, hdr, 测试",
    description: "描述",
    master: "母版",
    masterType: "母版类型",
    labelField: "标签名",
    hlsMode: "HLS 模式",
    copySourceStream: "拷贝源流",
    transcodeSdr: "转码 SDR 版本",
    notes: "备注",
    published: "发布",
    defaultMaster: "默认母版",
    overwriteHls: "覆盖现有 HLS",
    uploading: "上传中...",
    uploadVideo: "上传视频",
    uploadComplete: "上传完成，服务器已检测到元数据。",
    uploadingMessage: "正在上传并扫描源元数据...",
    networkError: "服务器响应前上传失败。",
    openVideoPage: "打开视频页面",
    hlsSelectFolder: "请选择完整的 HLS 包文件夹。",
    dvSelectFolder: "请选择完整的 Dolby Vision 包文件夹。",
    filesSelected: (n: number) => `已选择 ${n} 个文件`,
    httpError: (status: number) => `上传失败，HTTP ${status}。`,
    dropDrag: "拖放文件，或",
    dropBrowse: "点击选择",
    dropRelease: "松开即可上传",
    sourceModes: [
      {
        value: "embedded" as SourceKind,
        title: "嵌入式 MP4 / MOV",
        detail:
          "上传可直接在浏览器中播放的视频，Dolby Vision 通过嵌入的 DOVI/RPU 流元数据自动检测。",
      },
      {
        value: "master_package" as SourceKind,
        title: "DV 母版 / IMF / ProRes 包",
        detail:
          "上传完整文件夹/包，将同时扫描 XML 辅助文件、RPU 文件、MXF、IMF 及主要素材。",
      },
      {
        value: "hls_package" as SourceKind,
        title: "已验证 HLS 包",
        detail:
          "上传完整 HLS 文件夹。主播放列表须包含 VIDEO-RANGE，所有变体必须共享同一色彩协议。",
      },
    ],
  },
};

// ── FileDropZone ──────────────────────────────────────────────────────────────

function FileDropZone({
  accept,
  fileName,
  texts,
  onChange,
}: {
  accept?: string;
  fileName: string;
  texts: { drag: string; browse: string; release: string };
  onChange: (file: File | null) => void;
}) {
  const [isDragging, setIsDragging] = useState(false);
  const inputRef = useRef<HTMLInputElement>(null);

  function handleDragOver(e: React.DragEvent) {
    e.preventDefault();
    setIsDragging(true);
  }

  function handleDragLeave(e: React.DragEvent) {
    e.preventDefault();
    if (!e.currentTarget.contains(e.relatedTarget as Node)) {
      setIsDragging(false);
    }
  }

  function handleDrop(e: React.DragEvent) {
    e.preventDefault();
    setIsDragging(false);
    onChange(e.dataTransfer.files[0] ?? null);
  }

  function handleInputChange(e: React.ChangeEvent<HTMLInputElement>) {
    onChange(e.target.files?.[0] ?? null);
  }

  const hasFile = Boolean(fileName);

  return (
    <div
      className={[
        "file-drop-zone",
        isDragging && "drag-active",
        hasFile && "has-file",
      ]
        .filter(Boolean)
        .join(" ")}
      onDragOver={handleDragOver}
      onDragLeave={handleDragLeave}
      onDrop={handleDrop}
    >
      <input
        ref={inputRef}
        type="file"
        accept={accept}
        onChange={handleInputChange}
        tabIndex={-1}
      />

      <svg
        className="file-drop-zone-icon"
        viewBox="0 0 24 24"
        fill="none"
        stroke="currentColor"
        strokeWidth="1.5"
        strokeLinecap="round"
        strokeLinejoin="round"
        aria-hidden
      >
        <path d="M21 15v4a2 2 0 01-2 2H5a2 2 0 01-2-2v-4" />
        <polyline points="17 8 12 3 7 8" />
        <line x1="12" y1="3" x2="12" y2="15" />
      </svg>

      {hasFile ? (
        <span className="file-drop-zone-filename">{fileName}</span>
      ) : isDragging ? (
        <span className="file-drop-zone-release">{texts.release}</span>
      ) : (
        <span className="file-drop-zone-hint">
          {texts.drag}{" "}
          <span className="file-drop-zone-browse">{texts.browse}</span>
        </span>
      )}
    </div>
  );
}

// ── Helpers ───────────────────────────────────────────────────────────────────

function defaultMasterLabel(sourceKind: SourceKind, masterType: string) {
  const baseLabel =
    masterTypes.find((item) => item.value === masterType)?.label || "Custom";
  if (sourceKind === "hls_package") return `${baseLabel} HLS`;
  return sourceKind === "master_package" ? `${baseLabel} Master` : baseLabel;
}

// ── UploadVideoForm ───────────────────────────────────────────────────────────

export function UploadVideoForm({ lang = "zh" }: { lang?: Lang }) {
  const t = translations[lang];

  const [token, setToken] = useState("");
  const [title, setTitle] = useState("");
  const [slug, setSlug] = useState("");
  const [description, setDescription] = useState("");
  const [tags, setTags] = useState("");
  const [sourceKind, setSourceKind] = useState<SourceKind>("embedded");
  const [masterType, setMasterType] = useState("sdr");
  const [label, setLabel] = useState("SDR");
  const [mode, setMode] = useState("copy");
  const [notes, setNotes] = useState("");
  const [published, setPublished] = useState(true);
  const [isDefault, setIsDefault] = useState(true);
  const [overwrite, setOverwrite] = useState(false);
  const [video, setVideo] = useState<File | null>(null);
  const [masterPackageFiles, setMasterPackageFiles] = useState<File[]>([]);
  const [cover, setCover] = useState<File | null>(null);
  const [dolbyXmlClipName, setDolbyXmlClipName] = useState("");
  const [state, setState] = useState<UploadState>("idle");
  const [progress, setProgress] = useState(0);
  const [message, setMessage] = useState("");
  const [result, setResult] = useState<UploadResponse | null>(null);

  const selectedSourceMode =
    sourceKind !== "embedded"
      ? t.sourceModes.find((item) => item.value === sourceKind) ||
        t.sourceModes[1]
      : null;
  const sourceReady =
    sourceKind === "embedded" ? Boolean(video) : masterPackageFiles.length > 0;
  const canSubmit = useMemo(
    () =>
      Boolean(
        token.trim() &&
          title.trim() &&
          slug.trim() &&
          sourceReady &&
          state !== "uploading"
      ),
    [slug, sourceReady, state, title, token]
  );

  const dropTexts = {
    drag: t.dropDrag,
    browse: t.dropBrowse,
    release: t.dropRelease,
  };

  function updateSourceKind(value: SourceKind) {
    setSourceKind(value);
    setProgress(0);
    setMessage("");
    setResult(null);
    if (value === "embedded") {
      setMasterPackageFiles([]);
      setMasterType("sdr");
      setLabel(defaultMasterLabel(value, "sdr"));
      setMode("copy");
      return;
    }

    setVideo(null);
    const nextMasterType = value === "hls_package" ? "hdr10" : "dolby_vision";
    setMasterType(nextMasterType);
    setLabel(defaultMasterLabel(value, nextMasterType));
    setMode("copy");
  }

  function updateMasterType(value: string) {
    setMasterType(value);
    setLabel(defaultMasterLabel(sourceKind, value));
    setMode("copy");
  }

  function submit(event: FormEvent<HTMLFormElement>) {
    event.preventDefault();
    if (!canSubmit) return;

    setState("uploading");
    setProgress(0);
    setMessage(t.uploadingMessage);
    setResult(null);

    const form = new FormData();
    form.append("sourceKind", sourceKind);
    if (sourceKind === "embedded" && video) {
      form.append("video", video);
    }

    if (sourceKind === "master_package" || sourceKind === "hls_package") {
      for (const file of masterPackageFiles) {
        const relativePath =
          (file as File & { webkitRelativePath?: string })
            .webkitRelativePath || file.name;
        form.append("masterPackage", file, relativePath);
      }
    }

    if (cover) form.append("cover", cover);
    form.append("dolbyXmlClipName", dolbyXmlClipName.trim());
    form.append("title", title.trim());
    form.append("slug", slug.trim());
    form.append("description", description.trim());
    form.append("tags", tags.trim());
    form.append("masterType", masterType);
    form.append(
      "label",
      label.trim() ||
        masterTypes.find((item) => item.value === masterType)?.label ||
        "Video"
    );
    form.append("mode", mode);
    form.append("notes", notes.trim());
    form.append("published", String(published));
    form.append("isDefault", String(isDefault));
    form.append("overwrite", String(overwrite));

    const request = new XMLHttpRequest();
    request.open("POST", "/api/uploads/videos");
    request.setRequestHeader("Authorization", `Bearer ${token.trim()}`);

    request.upload.onprogress = (uploadEvent) => {
      if (!uploadEvent.lengthComputable) return;
      setProgress(Math.round((uploadEvent.loaded / uploadEvent.total) * 100));
    };

    request.onload = () => {
      let payload: UploadResponse | null = null;
      try {
        payload = request.responseText
          ? JSON.parse(request.responseText)
          : null;
      } catch {
        payload = null;
      }

      if (request.status >= 200 && request.status < 300) {
        setState("success");
        setProgress(100);
        setResult(payload);
        setMessage(t.uploadComplete);
        return;
      }

      setState("error");
      setMessage(payload?.error || t.httpError(request.status));
    };

    request.onerror = () => {
      setState("error");
      setMessage(t.networkError);
    };

    request.send(form);
  }

  const projectHref = result?.project?.slug
    ? `/videos/${result.project.slug}`
    : null;
  const packageSummary =
    masterPackageFiles.length > 0
      ? t.filesSelected(masterPackageFiles.length)
      : sourceKind === "hls_package"
        ? t.hlsSelectFolder
        : t.dvSelectFolder;

  return (
    <form className="upload-form" onSubmit={submit}>
      {/* ── Access ── */}
      <section className="upload-panel">
        <h2>{t.access}</h2>
        <div className="upload-grid">
          <label className="upload-wide">
            {t.uploadToken}
            <input
              type="password"
              value={token}
              onChange={(event) => setToken(event.target.value)}
              autoComplete="off"
              placeholder="UPLOAD_API_TOKEN"
              required
            />
          </label>
        </div>
      </section>

      {/* ── Source ── */}
      <section className="upload-panel">
        <h2>{t.source}</h2>
        <div
          className="upload-source-grid"
          role="radiogroup"
          aria-label={t.videoSourceType}
        >
          {t.sourceModes.map((item) => (
            <label
              className={
                item.value === sourceKind ? "source-mode active" : "source-mode"
              }
              key={item.value}
            >
              <input
                type="radio"
                name="sourceKind"
                value={item.value}
                checked={item.value === sourceKind}
                onChange={() => updateSourceKind(item.value)}
              />
              <span>{item.title}</span>
              <small>{item.detail}</small>
            </label>
          ))}
        </div>

        <div className="upload-grid">
          {sourceKind === "embedded" ? (
            <label className="upload-span-2">
              {t.sourceVideo}
              <FileDropZone
                accept="video/*,.mov,.mkv,.mp4,.m4v"
                fileName={video?.name || ""}
                texts={dropTexts}
                onChange={setVideo}
              />
            </label>
          ) : (
            <>
              <label className="upload-wide">
                {sourceKind === "hls_package"
                  ? t.completeHlsFolder
                  : t.completeMasterFolder}
                <input
                  type="file"
                  multiple
                  {...({ webkitdirectory: "", directory: "" } as DirectoryInputProps)}
                  onChange={(event) =>
                    setMasterPackageFiles(
                      Array.from(event.target.files || [])
                    )
                  }
                  required
                />
              </label>
              {sourceKind === "master_package" ? (
                <label className="upload-wide">
                  {t.xmlClipName}
                  <input
                    value={dolbyXmlClipName}
                    onChange={(event) =>
                      setDolbyXmlClipName(event.target.value)
                    }
                    placeholder={t.xmlClipNamePlaceholder}
                  />
                </label>
              ) : null}
            </>
          )}

          <label>
            {t.coverImage}
            <FileDropZone
              accept="image/*"
              fileName={cover?.name || ""}
              texts={dropTexts}
              onChange={setCover}
            />
          </label>

          {sourceKind !== "embedded" && selectedSourceMode ? (
            <div className="upload-source-note">
              <strong>{selectedSourceMode.title}</strong>
              <span>{packageSummary}</span>
            </div>
          ) : null}
        </div>
      </section>

      {/* ── Metadata ── */}
      <section className="upload-panel">
        <h2>{t.metadata}</h2>
        <div className="upload-grid">
          <label>
            {t.titleLabel}
            <input
              value={title}
              onChange={(event) => setTitle(event.target.value)}
              required
            />
          </label>
          <label>
            {t.slug}
            <input
              value={slug}
              onChange={(event) => setSlug(event.target.value)}
              pattern="[a-z0-9]+(?:-[a-z0-9]+)*"
              placeholder="dolby-vision-test"
              required
            />
          </label>
          <label>
            {t.tags}
            <input
              value={tags}
              onChange={(event) => setTags(event.target.value)}
              placeholder={t.tagsPlaceholder}
            />
          </label>
          <label className="upload-wide">
            {t.description}
            <textarea
              value={description}
              onChange={(event) => setDescription(event.target.value)}
              rows={4}
            />
          </label>
        </div>
      </section>

      {/* ── Master ── */}
      <section className="upload-panel">
        <h2>{t.master}</h2>
        <div className="upload-grid">
          <label>
            {t.masterType}
            <select
              value={masterType}
              onChange={(event) => updateMasterType(event.target.value)}
            >
              {masterTypes.map((type) => (
                <option key={type.value} value={type.value}>
                  {type.label}
                </option>
              ))}
            </select>
          </label>
          <label>
            {t.labelField}
            <input
              value={label}
              onChange={(event) => setLabel(event.target.value)}
            />
          </label>
          <label>
            {t.hlsMode}
            <select
              value={mode}
              onChange={(event) => setMode(event.target.value)}
              disabled={masterType !== "sdr" && masterType !== "custom"}
            >
              <option value="copy">{t.copySourceStream}</option>
              <option value="transcode">{t.transcodeSdr}</option>
            </select>
          </label>
          <label className="upload-wide">
            {t.notes}
            <textarea
              value={notes}
              onChange={(event) => setNotes(event.target.value)}
              rows={4}
            />
          </label>
        </div>

        <div className="upload-checks">
          <label>
            <input
              type="checkbox"
              checked={published}
              onChange={(event) => setPublished(event.target.checked)}
            />
            {t.published}
          </label>
          <label>
            <input
              type="checkbox"
              checked={isDefault}
              onChange={(event) => setIsDefault(event.target.checked)}
            />
            {t.defaultMaster}
          </label>
          <label>
            <input
              type="checkbox"
              checked={overwrite}
              onChange={(event) => setOverwrite(event.target.checked)}
            />
            {t.overwriteHls}
          </label>
        </div>
      </section>

      {/* ── Actions ── */}
      <div className="upload-actions">
        <button type="submit" disabled={!canSubmit}>
          {state === "uploading" ? t.uploading : t.uploadVideo}
        </button>
        <div className="upload-progress" aria-live="polite">
          <span style={{ width: `${progress}%` }} />
        </div>
      </div>

      {/* ── Status / Result ── */}
      {message ? (
        <div
          className={
            state === "error" ? "upload-status error" : "upload-status"
          }
          role="status"
        >
          <p>{message}</p>
          {result?.masterPackage ? (
            <code>
              package={result.masterPackage.fileCount} files, sidecars=
              {result.masterPackage.sidecarCount}, source=
              {result.masterPackage.sourceFile}
            </code>
          ) : null}
          {result?.hlsUrl ? <code>{result.hlsUrl}</code> : null}
          {result?.colorContract ? (
            <code>
              gamut={result.colorContract.displayGamutLabel || "N/A"},
              primaries={result.colorContract.colorPrimaries || "N/A"},
              transfer={result.colorContract.colorTransfer || "N/A"},
              video-range={result.colorContract.hlsVideoRange || "N/A"}
            </code>
          ) : null}
          {result?.verification?.status ? (
            <code>
              verification={result.verification.status}
              {result.verification.verifiedAt
                ? ` at ${result.verification.verifiedAt}`
                : ""}
            </code>
          ) : null}
          {projectHref ? (
            <a href={projectHref}>{t.openVideoPage}</a>
          ) : null}
        </div>
      ) : null}
    </form>
  );
}
