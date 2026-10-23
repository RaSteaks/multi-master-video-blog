"use client";

import { FormEvent, useEffect, useMemo, useRef, useState } from "react";
import type { Lang } from "@/components/UploadPageClient";
import { SLUG_MAX_LENGTH, SLUG_PATTERN, sanitizeSlugInput, slugify, slugifyFileName, timestampSlug } from "@/lib/slug";
import { VideoProjectPicker, type UploadProject } from "./VideoProjectPicker";
import { VideoFormatInfo } from "./VideoFormatInfo";
import type { SourceFormat } from "@/lib/video-format";
import { matchUploadFiles, rememberedVideoUpload, rememberVideoUpload, transferVideoUpload,
  uploadDelay, uploadManifest, uploadRequest, type UploadProgress, type VideoUploadSession } from "@/lib/video-upload";

type UploadState = "idle" | "uploading" | "paused" | "queued" | "processing" | "success" | "error";
type SourceKind = "embedded" | "master_package" | "hls_package";

type UploadResponse = {
  status: string;
  processingInterrupted?: boolean;
  sourceFormat?: SourceFormat | null;
  master?: { type: string };
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
    conversion?: { intent?: string; usesDolbyMetadata?: boolean };
  };
  sourceKind?: SourceKind;
  masterPackage?: {
    fileCount: number;
    sourceFile: string;
    sidecarCount: number;
  } | null;
  project?: {
    id?: number;
    slug?: string;
  };
  companionSdr?: { status: "ready" | "failed"; hlsUrl?: string; error?: string } | null;
  error?: string;
  sdrDerivative?: {
    status: "ready" | "failed";
    hlsUrl?: string;
    error?: string;
  } | null;
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
    imfConverted: "RGB IMF was converted to HDR10 for playback. The original package is retained; its Dolby Vision dynamic metadata is not applied to HDR10 or automatic SDR playback.",
    sourcePairNote: "Select or drop one master, or an HDR + SDR pair together. The server identifies the two formats from video metadata, regardless of file order.",
    autoHdrType: "HDR type will be detected from the two source videos.", tooMany: "Select at most two source videos: one HDR and one SDR.",
    removeSource: "Remove", selectedPair: "Two source masters selected",
    target: "Project", newProject: "Create a project", existingProject: "Add to an existing project",
    existingNote: "Project information is read from the server and will not be changed by this upload.",
    pairedSdr: "Include an SDR master", pairedNote: "Upload your matching BT.709 MP4/MOV export. Both masters share this project's information; no automatic SDR is generated.",
    pairedFile: "Matching SDR master", removeFile: "Remove SDR file", addMaster: "Add another master", addSdr: "Add SDR to this project",
    pairedComplete: "HDR and your SDR master are ready in the same project.",
    pairedPartial: "HDR was saved, but the supplied SDR could not be saved. Add SDR to this project to retry without uploading HDR again.",
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
    invalidSlug: "Use lowercase letters, numbers, and single hyphens, without a leading or trailing hyphen.",
    slugGenerate: "Generate",
    slugGenerateLabel: "Generate slug from title or file name",
    slugAddress: "Address",
    slugRulesTitle: "Slug rules",
    slugRules: [
      "Lowercase letters (a–z), numbers (0–9) and hyphens (-) only.",
      "No spaces, underscores or non-Latin text; use English or pinyin.",
      "No leading, trailing or repeated hyphens. Max 200 characters; ≤ 60 recommended.",
      "It becomes the page URL and media folder name and must be unique. Do not change it after publishing.",
    ],
    slugExample: "Good: black-hole-dolby-vision · Bad: Black_Hole 杜比",
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
    defaultSdrMaster: "Use generated SDR as default",
    automaticSdr: "For a new project, HDR without a supplied SDR creates an automatic SDR playback version. Existing projects are not backfilled.",
    processingDolby: "Upload received. Verifying and preparing the video masters…",
    dolbyComplete: "HDR and the automatic SDR are ready. You can switch versions on the video page.",
    dolbyPartial: "HDR was saved, but SDR generation failed. You can add an SDR master to this project.",
    overwriteHls: "Overwrite existing HLS",
    uploading: "Uploading...",
    uploadVideo: "Upload Video",
    uploadComplete: "Upload complete. Metadata was detected by the server.",
    uploadingMessage: "Uploading and scanning source metadata...",
    networkError: "Upload failed before the server responded.",
    openVideoPage: "Open video page",
    hlsSelectFolder: "Select the complete HLS package folder.",
    dvSelectFolder: "Select the complete HEVC or RGB IMF package folder.",
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
        title: "HEVC / RGB IMF package",
        detail:
          "Upload a playable HEVC master or a complete RGB/PQ IMF folder with CPL and ASSETMAP. RGB IMF is converted to HDR10; Dolby Vision dynamic metadata remains in the source archive. Playable Dolby Vision requires embedded RPU.",
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
    imfConverted: "RGB IMF 已转换为 HDR10 播放版，原始包已保留。包内的 Dolby Vision 动态元数据不应用于 HDR10 或自动生成的 SDR 播放版。",
    sourcePairNote: "可选择或拖入一份母版，也可一次加入 HDR 和 SDR 两份母版。服务器根据视频元数据识别类型，无需按顺序选择。",
    autoHdrType: "已选择两份源视频，HDR 类型将根据视频元数据自动识别。", tooMany: "最多选择两份源视频：一份 HDR 和一份 SDR。",
    removeSource: "移除", selectedPair: "已选择两份源视频母版",
    target: "所属项目", newProject: "新建项目", existingProject: "为已有项目添加母版",
    existingNote: "使用服务器中保存的项目资料。本次上传不会修改标题、简介、标签、封面或发布状态。",
    pairedSdr: "同时上传 SDR 母版", pairedNote: "选择同一作品的 BT.709 MP4/MOV 导出。两份母版共用项目资料，不再自动生成 SDR。",
    pairedFile: "配对 SDR 母版", removeFile: "移除 SDR 文件", addMaster: "继续添加母版", addSdr: "为此项目补充 SDR",
    pairedComplete: "HDR 和你上传的 SDR 母版已保存到同一项目。",
    pairedPartial: "HDR 已保存，但配对 SDR 保存失败。可为此项目补充 SDR，无需重传 HDR。",
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
    invalidSlug: "Slug 只能包含小写英文字母、数字和单个短横线，且不能以短横线开头或结尾。",
    slugGenerate: "生成",
    slugGenerateLabel: "根据标题或文件名生成 Slug",
    slugAddress: "访问地址",
    slugRulesTitle: "Slug 填写规范",
    slugRules: [
      "仅限小写英文字母（a–z）、数字（0–9）和短横线（-）。",
      "不要使用空格、下划线或中文；中文标题请写英文或拼音。",
      "不能以短横线开头或结尾，也不能连续出现；最长 200 字符，建议不超过 60。",
      "它会成为页面地址和媒体目录名，必须唯一，发布后请勿修改。",
    ],
    slugExample: "正确：black-hole-dolby-vision · 错误：Black_Hole 杜比",
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
    defaultSdrMaster: "将自动生成的 SDR 设为默认",
    automaticSdr: "仅新项目上传 HDR 且未随附 SDR 时，自动生成 SDR 播放版本；已有项目不自动补生成。",
    processingDolby: "文件已上传，正在校验并处理视频母版…",
    dolbyComplete: "HDR 和自动生成的 SDR 均已就绪，可在播放页切换。",
    dolbyPartial: "HDR 已保存，但 SDR 生成失败。可为此项目补充 SDR 母版。",
    overwriteHls: "覆盖现有 HLS",
    uploading: "上传中...",
    uploadVideo: "上传视频",
    uploadComplete: "上传完成，服务器已检测到元数据。",
    uploadingMessage: "正在上传并扫描源元数据...",
    networkError: "服务器响应前上传失败。",
    openVideoPage: "打开视频页面",
    hlsSelectFolder: "请选择完整的 HLS 包文件夹。",
    dvSelectFolder: "请选择完整的 HEVC 或 RGB IMF 包文件夹。",
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
        title: "HEVC / RGB IMF 母版包",
        detail:
          "上传可播放 HEVC 母版，或含 CPL、ASSETMAP 的完整 RGB/PQ IMF 文件夹。RGB IMF 会转换为 HDR10，Dolby Vision 动态元数据保留在原包中。可播放 Dolby Vision 仍须内嵌 RPU。",
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
  multiple = false,
  onFilesChange,
}: {
  accept?: string;
  fileName: string;
  texts: { drag: string; browse: string; release: string };
  onChange: (file: File | null) => void;
  multiple?: boolean;
  onFilesChange?: (files: File[]) => void;
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
    // Disabled fieldsets block native inputs but do not suppress custom drop handlers.
    if (inputRef.current?.matches(":disabled")) return;
    if (onFilesChange) onFilesChange(Array.from(e.dataTransfer.files));
    else onChange(e.dataTransfer.files[0] ?? null);
  }

  function handleInputChange(e: React.ChangeEvent<HTMLInputElement>) {
    if (onFilesChange) onFilesChange(Array.from(e.target.files || []));
    else onChange(e.target.files?.[0] ?? null);
    // Selection lives in React state, so removing a file must allow choosing the same pair again.
    e.target.value = "";
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
        multiple={multiple}
        accept={accept}
        onChange={handleInputChange}
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

export function UploadVideoForm({ lang = "zh", initialProjectId }: { lang?: Lang; initialProjectId?: string }) {
  const t = translations[lang];

  const [token, setToken] = useState("");
  const [showToken, setShowToken] = useState(false);
  const [appendProject, setAppendProject] = useState(Boolean(initialProjectId));
  const [selectedProject, setSelectedProject] = useState<UploadProject | null>(null);
  const [pairedSdr, setPairedSdr] = useState(false);
  const [sdrVideo, setSdrVideo] = useState<File | null>(null);
  const requestRef = useRef<AbortController | null>(null);
  const sourcesRef = useRef<File[]>([]);
  const [sessionId, setSessionId] = useState<string | null>(null);
  const [session, setSession] = useState<VideoUploadSession<UploadResponse> | null>(null);
  const [resumeFiles, setResumeFiles] = useState<File[]>([]);
  const [transfer, setTransfer] = useState<UploadProgress | null>(null);
  const [storageWarning, setStorageWarning] = useState(false);
  const [hydrated, setHydrated] = useState(false);
  const [title, setTitle] = useState("");
  const [slug, setSlug] = useState("");
  const [slugTouched, setSlugTouched] = useState(false);
  const [description, setDescription] = useState("");
  const [tags, setTags] = useState("");
  const [sourceKind, setSourceKind] = useState<SourceKind>("embedded");
  const [masterType, setMasterType] = useState("sdr");
  const [label, setLabel] = useState("SDR");
  const [mode, setMode] = useState("copy");
  const [notes, setNotes] = useState("");
  const [published, setPublished] = useState(true);
  const [isDefault, setIsDefault] = useState(!initialProjectId);
  const [overwrite, setOverwrite] = useState(false);
  const [video, setVideo] = useState<File | null>(null);
  const [masterPackageFiles, setMasterPackageFiles] = useState<File[]>([]);
  const [cover, setCover] = useState<File | null>(null);
  const [dolbyXmlClipName, setDolbyXmlClipName] = useState("");
  const [state, setState] = useState<UploadState>("idle");
  const [progress, setProgress] = useState(0);
  const [message, setMessage] = useState("");
  const [result, setResult] = useState<UploadResponse | null>(null);
  const [sourceError, setSourceError] = useState("");
  const embeddedPair = sourceKind === "embedded" && Boolean(video && sdrVideo);
  const isHdr = ["hdr10", "hlg", "dolby_vision"].includes(masterType);

  // Until the user edits the slug by hand, derive it from the title, then from the source file name.
  useEffect(() => {
    if (appendProject || slugTouched) return;
    setSlug(slugify(title) || (video ? slugifyFileName(video.name) : ""));
  }, [title, video, appendProject, slugTouched]);

  useEffect(() => {
    if (!selectedProject) return;
    setTitle(selectedProject.title); setSlug(selectedProject.slug);
    setDescription(selectedProject.description || ""); setTags((selectedProject.tags || []).join(", "));
    setPublished(Boolean(selectedProject.published)); setIsDefault(false); setCover(null);
  }, [selectedProject]);

  useEffect(() => {
    // File selections cannot be restored after navigation; warn before losing a queued upload.
    const warn = (event: BeforeUnloadEvent) => { event.preventDefault(); event.returnValue = ""; };
    if (["success", "queued", "processing"].includes(state) || !(video || sdrVideo || masterPackageFiles.length)) return;
    window.addEventListener("beforeunload", warn);
    return () => window.removeEventListener("beforeunload", warn);
  }, [video, sdrVideo, masterPackageFiles.length, state]);

  useEffect(() => {
    setSessionId(rememberedVideoUpload());
    // Keep SSR inputs inert until React owns changes and the recovery bookmark has loaded.
    setHydrated(true);
    return () => { requestRef.current?.abort(); };
  }, []);

  const copy = lang === "zh" ? {
    recover: "恢复上传 / 刷新状态", saved: "有可恢复的视频上传。输入上传令牌后读取进度。",
    pause: "暂停上传", resume: "继续上传", paused: "上传已暂停，已确认的数据保留。",
    select: "重新选择原文件", folder: "重新选择原文件夹", selected: "已选择待核对文件",
    reselect: "请选择原来的所有文件（含配对母版和封面），再继续上传。已上传部分会核对后跳过。",
    queued: "上传已完成，等待服务器处理。可以离开页面后回来查询。",
    processing: "上传已完成，正在校验、打包及处理视频。可以稍后回来查询。",
    interrupted: "主母版已保存，但后续处理被中断。请先检查已有母版，需要时为此项目补充 SDR。",
    uncertain: "发布过程被中断，结果待确认。请检查项目中已有的母版，避免重复上传。",
    verifying: "正在核对已上传数据…", retrying: "连接暂时中断，正在重试…", uploading: "正在上传…",
    forget: "移除此设备的恢复记录", forgetNote: "仅移除本机记录，服务器上的任务仍会继续；未完成文件将在保留期后清理。",
    cancel: "取消此上传", canceled: "上传已取消。", storage: "浏览器无法保存恢复记录，请保留此任务 ID：",
    expires: "恢复记录至少保留至", confirmed: "已确认", speed: "速度", remaining: "预计剩余", minutes: "分钟",
    error: "连接失败。已确认的数据保留，请检查网络或令牌后恢复。", title: "上传任务",
  } : {
    recover: "Recover upload / refresh status", saved: "A video upload can be recovered. Enter your upload token to check it.",
    pause: "Pause upload", resume: "Resume upload", paused: "Upload paused. Confirmed data is retained.",
    select: "Reselect original files", folder: "Reselect original folder", selected: "Files selected for verification",
    reselect: "Reselect all original files, including paired masters and the cover. Confirmed bytes will be verified and skipped.",
    queued: "Upload received. Waiting for processing. You can return later to check it.",
    processing: "Upload received. Verifying and preparing the video. You can return later to check it.",
    interrupted: "The primary master was saved, but later processing was interrupted. Check existing masters before adding SDR.",
    uncertain: "Publication was interrupted and its result needs checking. Check existing masters before another upload.",
    verifying: "Verifying confirmed data…", retrying: "Connection interrupted. Retrying…", uploading: "Uploading…",
    forget: "Remove recovery record from this device", forgetNote: "This only removes the local record. Server jobs continue; unfinished files expire after the retention period.",
    cancel: "Cancel this upload", canceled: "Upload canceled.", storage: "The browser could not save recovery information. Keep this task ID:",
    expires: "Recovery available at least until", confirmed: "Confirmed", speed: "Speed", remaining: "Estimated remaining", minutes: "min",
    error: "Connection failed. Confirmed data is retained; check your network or token, then recover.", title: "Upload task",
  };
  const busy = ["uploading", "queued", "processing"].includes(state);

  function successMessage(payload: UploadResponse | null) {
    return payload?.processingInterrupted ? copy.interrupted
      : payload?.companionSdr?.status === "ready" ? t.pairedComplete
      : payload?.companionSdr?.status === "failed" ? t.pairedPartial
      : payload?.sdrDerivative?.status === "ready" ? t.dolbyComplete
      : payload?.sdrDerivative?.status === "failed" ? t.dolbyPartial : t.uploadComplete;
  }
  // Derive completed and active phase copy from the current locale, even during a language switch.
  const statusMessage = state === "success" ? successMessage(result)
    : state === "queued" || state === "processing" ? copy[state]
    : state === "uploading" && transfer ? copy[transfer.activity] : message;

  function acceptSession(current: VideoUploadSession<UploadResponse>) {
    setSession(current);
    const total = current.files.reduce((sum, file) => sum + file.size, 0);
    setProgress(total ? Math.floor(current.files.reduce((sum, file) => sum + file.offset, 0) / total * 100) : 0);
    if (current.state === "completed") {
      const payload = current.result;
      setState("success"); setResult(payload); rememberVideoUpload(null);
      setMessage(successMessage(payload));
    } else if (current.state === "failed" || current.state === "interrupted") {
      setState("error"); setResult(current.result);
      setMessage(current.state === "interrupted" ? copy.uncertain : current.error || copy.error);
    } else if (current.state === "canceled") { setState("paused"); setMessage(copy.canceled); }
    else if (current.state === "receiving") { setState("paused"); setMessage(copy.reselect); }
    else { setState(current.state); setMessage(copy[current.state]); }
  }

  async function runUpload(form?: FormData, resume = false) {
    if (requestRef.current || !token.trim()) return;
    const controller = new AbortController(); requestRef.current = controller;
    const credential = token.trim();
    setState("uploading"); setMessage(copy.verifying);
    try {
      let current: VideoUploadSession<UploadResponse>;
      if (form) {
        const manifest = await uploadManifest(form, controller.signal);
        sourcesRef.current = manifest.sources;
        const id = crypto.randomUUID();
        setSessionId(id); setStorageWarning(!rememberVideoUpload(id));
        // A stable client ID makes a lost creation response recoverable without duplicate jobs.
        for (let attempt = 0; ; attempt++) {
          try { current = await uploadRequest(id, credential, controller.signal, "PUT", "", manifest.body); break; }
          catch (error) {
            const status = (error as { status?: number }).status;
            if (controller.signal.aborted || attempt >= 4 || (status && ![408, 409, 429, 500, 502, 503, 504].includes(status))) throw error;
            setMessage(copy.retrying);
            await uploadDelay(Math.min(16_000, 1000 * 2 ** attempt), controller.signal);
          }
        }
      } else {
        if (!sessionId) return;
        current = await uploadRequest(sessionId, credential, controller.signal);
      }
      acceptSession(current);
      if (current.state === "receiving") {
        if (!form && !resume) return;
        if (!sourcesRef.current.length) sourcesRef.current = await matchUploadFiles(current.files, resumeFiles, controller.signal);
        setState("uploading");
        current = await transferVideoUpload(current, sourcesRef.current, credential, controller.signal, value => {
          setTransfer(value); setProgress(Math.floor(value.confirmed / value.total * 100)); setMessage(copy[value.activity]);
        });
        acceptSession(current);
      }
      let failures = 0;
      while (["queued", "processing"].includes(current.state)) {
        await uploadDelay(document.hidden ? 15_000 : 3000, controller.signal);
        try {
          current = await uploadRequest(current.id, credential, controller.signal);
          failures = 0; acceptSession(current);
        } catch (error) {
          if (controller.signal.aborted || ++failures >= 5 || (error as { status?: number }).status === 401) throw error;
          setMessage(copy.retrying);
        }
      }
    } catch (error) {
      if (controller.signal.aborted) { setState("paused"); setMessage(copy.paused); }
      else {
        // A mismatching selection must be replaceable on the next resume attempt.
        if ([400, 422].includes((error as { status?: number }).status || 0)) {
          sourcesRef.current = []; setResumeFiles([]);
        }
        setState("error");
        const detail = error instanceof Error ? error.message : "";
        setMessage([400, 422].includes((error as { status?: number }).status || 0) ? detail : `${copy.error} ${detail}`);
      }
    } finally { if (requestRef.current === controller) requestRef.current = null; }
  }

  async function cancelUpload() {
    if (!sessionId || requestRef.current) return;
    const controller = new AbortController(); requestRef.current = controller;
    try { acceptSession(await uploadRequest(sessionId, token.trim(), controller.signal, "POST", "/cancel")); }
    catch (error) { setMessage(error instanceof Error ? error.message : copy.error); }
    finally { requestRef.current = null; }
  }

  function forgetUpload() {
    // This removes a device bookmark only; it must not delete sources or cancel a remote job.
    rememberVideoUpload(null); setSessionId(null); setSession(null); sourcesRef.current = [];
    setResumeFiles([]); setTransfer(null); setState("idle"); setMessage(""); setResult(null); setProgress(0);
  }

  const selectedSourceMode =
    sourceKind !== "embedded"
      ? t.sourceModes.find((item) => item.value === sourceKind) ||
        t.sourceModes[1]
      : null;
  const sourceReady =
    sourceKind === "embedded" ? Boolean(video) : masterPackageFiles.length > 0;
  const slugInvalid = Boolean(slug.trim() && !SLUG_PATTERN.test(slug.trim()));
  const generateSlug = () => {
    setSlug(slugify(title) || (video ? slugifyFileName(video.name) : "") || timestampSlug());
    setSlugTouched(true);
  };
  const canSubmit = useMemo(
    () =>
      Boolean(
        token.trim() &&
          title.trim() &&
          slug.trim() &&
          !slugInvalid &&
          sourceReady &&
          !sourceError &&
          (!appendProject || selectedProject) &&
          (!pairedSdr || !isHdr || sdrVideo) &&
          !sessionId && state !== "uploading" && state !== "success"
      ),
    [sessionId, slug, slugInvalid, sourceReady, state, title, token, appendProject, selectedProject, pairedSdr, isHdr, sdrVideo, sourceError]
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
    setPairedSdr(false); setSdrVideo(null); setSourceError("");
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
    if (!["hdr10", "hlg", "dolby_vision"].includes(value)) { setPairedSdr(false); setSdrVideo(null); }
  }

  function selectSourceFiles(files: File[]) {
    if (files.length > 2) { setSourceError(t.tooMany); return; }
    setSourceError("");
    setVideo(files[0] || null); setSdrVideo(files[1] || null);
    setPairedSdr(files.length === 2);
    if (files.length === 2) { setMode("copy"); setLabel("HDR"); }
    else setLabel(defaultMasterLabel(sourceKind, masterType));
  }

  function submit(event: FormEvent<HTMLFormElement>) {
    event.preventDefault();
    if (!canSubmit || requestRef.current) return;

    setState("uploading");
    setProgress(0);
    setMessage(t.uploadingMessage);
    setResult(null);

    const form = new FormData();
    if (appendProject && selectedProject) form.append("projectId", String(selectedProject.id));
    // Embedded pairs use the same multipart field, matching the single source picker.
    if (embeddedPair && sdrVideo) form.append("video", sdrVideo);
    else if (sourceKind !== "embedded" && isHdr && pairedSdr && sdrVideo) form.append("sdrVideo", sdrVideo);
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

    void runUpload(form);
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
    <form className="upload-form" noValidate onSubmit={submit}>
      {/* ── Access ── */}
      <section className="upload-panel">
        <h2>{t.access}</h2>
        <div className="upload-grid">
          <label className="upload-wide">
            {t.uploadToken}
            <input
              type={showToken ? "text" : "password"}
              value={token}
              onChange={(event) => setToken(event.target.value)}
              autoComplete="off"
              disabled={!hydrated}
              placeholder="UPLOAD_API_TOKEN"
              required
            />
          </label>
          <button className="upload-token-toggle" type="button" disabled={!hydrated}
            aria-pressed={showToken} onClick={() => setShowToken(value => !value)}>
            {lang === "zh" ? (showToken ? "隐藏令牌" : "显示令牌") : (showToken ? "Hide token" : "Show token")}
          </button>
        </div>
      </section>

      {sessionId ? <section className="upload-panel upload-recovery" aria-labelledby="upload-task-heading">
        <h2 id="upload-task-heading">{copy.title}</h2>
        <p className="field-note">{session ? session.fields.title || session.fields.projectId : copy.saved}</p>
        <code>{sessionId}</code>
        {storageWarning ? <p role="alert">{copy.storage} {sessionId}</p> : null}
        {session ? <>
          <p className="field-note">{copy.expires}: {new Date(session.expiresAt).toLocaleString(lang === "zh" ? "zh-CN" : "en-US")}</p>
          <ul className="upload-file-status">{session.files.map((file, index) => <li key={index}>
            <span>{file.name}</span><span>{Math.floor(file.offset / file.size * 100)}%</span>
          </li>)}</ul>
        </> : null}
        <div className="upload-progress" role="progressbar" aria-label={copy.confirmed}
          aria-valuemin={0} aria-valuemax={100} aria-valuenow={progress}>
          <span style={{ width: `${progress}%` }} />
        </div>
        <p className="field-note upload-transfer-details">{copy.confirmed}: {progress}%
          {state === "uploading" && transfer?.bytesPerSecond ? <> · {copy.speed}: {(transfer.bytesPerSecond / 1024).toFixed(0)} KiB/s
            · {copy.remaining}: {Math.ceil((transfer.total - transfer.confirmed) / transfer.bytesPerSecond / 60)} {copy.minutes}</> : null}
        </p>
        {session?.state === "receiving" && !busy && !sourcesRef.current.length ? <>
          <p className="field-note">{copy.reselect}</p>
          <label>{copy.select}<input type="file" multiple onChange={event => setResumeFiles(files => [...files, ...Array.from(event.target.files || [])])} /></label>
          <label>{copy.folder}<input type="file" multiple {...({ webkitdirectory: "", directory: "" } as DirectoryInputProps)}
            onChange={event => setResumeFiles(files => [...files, ...Array.from(event.target.files || [])])} /></label>
          <p className="field-note">{copy.selected}: {resumeFiles.length}</p>
        </> : null}
        <div className="upload-actions">
          {state === "uploading" ? <button type="button" onClick={() => requestRef.current?.abort()}>{copy.pause}</button> : null}
          {!busy && state !== "success" ? <button type="button" disabled={!token.trim()}
            onClick={() => void runUpload(undefined, session?.state === "receiving")}>{session?.state === "receiving" ? copy.resume : copy.recover}</button> : null}
          {!busy && session?.state === "receiving" ? <button className="upload-secondary" type="button" disabled={!token.trim()} onClick={() => void cancelUpload()}>{copy.cancel}</button> : null}
          {!busy ? <button className="upload-secondary" type="button" onClick={forgetUpload}>{copy.forget}</button> : null}
        </div>
        {!busy ? <p className="field-note">{copy.forgetNote}</p> : null}
      </section> : null}
      <fieldset className="upload-form upload-fields" disabled={!hydrated || busy || Boolean(sessionId)} hidden={Boolean(sessionId)}>
      <section className="upload-panel">
        <h2>{t.target}</h2>
        <div className="upload-checks">
          <label><input type="radio" name="projectTarget" checked={!appendProject} onChange={() => {
            setAppendProject(false); setSelectedProject(null); setTitle(""); setSlug(""); setSlugTouched(false); setDescription(""); setTags(""); setIsDefault(true);
          }} />{t.newProject}</label>
          <label><input type="radio" name="projectTarget" checked={appendProject} onChange={() => {
            setAppendProject(true); setIsDefault(false); setCover(null);
          }} />{t.existingProject}</label>
        </div>
        {appendProject ? <>
          <p className="field-note">{t.existingNote}</p>
          <VideoProjectPicker token={token} lang={lang} initialProjectId={initialProjectId}
            selected={selectedProject} onSelect={setSelectedProject} />
        </> : null}
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

        {/* Source files and cover share two balanced columns, independent of metadata fields. */}
        <div className="upload-assets-grid">
          {sourceKind === "embedded" ? (
            <div className={appendProject ? "upload-wide" : undefined}>
            <label>
              {t.sourceVideo}
              <FileDropZone
                accept="video/*,.mov,.mkv,.mp4,.m4v"
                multiple
                fileName={embeddedPair ? t.selectedPair : video?.name || ""}
                texts={dropTexts}
                onChange={setVideo}
                onFilesChange={selectSourceFiles}
              />
            </label>
            <p className="field-note">{t.sourcePairNote}</p>
            {sourceError ? <p role="alert">{sourceError}</p> : null}
            {[video, sdrVideo].filter((file): file is File => Boolean(file)).map((file, index, files) =>
              <div className="upload-source-file" key={`${index}-${file.name}`}>
                <span>{file.name} · {(file.size / 1024 / 1024).toFixed(2)} MiB</span>
                <button type="button" aria-label={`${t.removeSource} ${file.name}`}
                  onClick={() => selectSourceFiles(files.filter((_, position) => position !== index))}>{t.removeSource}</button>
              </div>)}
            </div>
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

          {!appendProject ? <label>
            {t.coverImage}
            <FileDropZone
              accept="image/*"
              fileName={cover?.name || ""}
              texts={dropTexts}
              onChange={setCover}
            />
          </label> : null}

          {sourceKind !== "embedded" && selectedSourceMode ? (
            <div className={`upload-source-note${appendProject ? " upload-wide" : ""}`}>
              <strong>{selectedSourceMode.title}</strong>
              <span>{packageSummary}</span>
            </div>
          ) : null}
        </div>
        {/* Keep the optional SDR controls together instead of distributing them across the field grid. */}
        {isHdr && sourceKind !== "embedded" ? (
          <div className="upload-companion">
            <div className="upload-checks">
              <label>
                <input
                  type="checkbox"
                  checked={pairedSdr}
                  aria-controls="paired-sdr-fields"
                  aria-describedby="paired-sdr-note"
                  onChange={event => {
                    setPairedSdr(event.target.checked);
                    if (!event.target.checked) setSdrVideo(null);
                  }}
                />
                {t.pairedSdr}
              </label>
            </div>
            <p id="paired-sdr-note" className="field-note">{t.pairedNote}</p>
            <div id="paired-sdr-fields" hidden={!pairedSdr}>
              {pairedSdr ? <>
                <label>
                  {t.pairedFile}
                  <input
                    type="file"
                    accept="video/mp4,video/quicktime,.mp4,.mov,.m4v"
                    onChange={event => setSdrVideo(event.target.files?.[0] || null)}
                  />
                </label>
                {sdrVideo ? <p className="field-note upload-companion-file">
                  {sdrVideo.name} · {(sdrVideo.size / 1024 / 1024).toFixed(1)} MiB
                </p> : null}
              </> : null}
            </div>
          </div>
        ) : null}

      </section>

      {/* ── Metadata ── */}
      <section className="upload-panel">
        <h2>{t.metadata}</h2>
        <div className="upload-grid">
          <label>
            {t.titleLabel}
            <input
              value={title}
              readOnly={appendProject}
              onChange={(event) => setTitle(event.target.value)}
              required
            />
          </label>
          <div className="slug-field upload-wide">
            <label htmlFor="video-slug">{t.slug}</label>
            <div className="slug-input">
              <input
                id="video-slug"
                value={slug}
                readOnly={appendProject}
                onChange={(event) => {
                  setSlug(sanitizeSlugInput(event.target.value));
                  setSlugTouched(true);
                }}
                onBlur={() => setSlug((value) => value.replace(/-+$/, ""))}
                maxLength={SLUG_MAX_LENGTH}
                pattern="[a-z0-9]+(?:-[a-z0-9]+)*"
                autoCapitalize="none"
                autoComplete="off"
                spellCheck={false}
                aria-invalid={slugInvalid}
                aria-describedby={slugInvalid ? "video-slug-error video-slug-rules" : "video-slug-rules"}
                placeholder="black-hole-dolby-vision"
                required
              />
              {appendProject ? null : (
                <button type="button" onClick={generateSlug} aria-label={t.slugGenerateLabel}>
                  {t.slugGenerate}
                </button>
              )}
            </div>
            <p className="slug-preview">
              {t.slugAddress} <code>/videos/<strong>{slug || "…"}</strong></code>
            </p>
            {slugInvalid ? <p className="slug-error" id="video-slug-error" role="alert">{t.invalidSlug}</p> : null}
            {appendProject ? null : (
              <div className="slug-rules" id="video-slug-rules">
                <p>{t.slugRulesTitle}</p>
                <ul>{t.slugRules.map((rule) => <li key={rule}>{rule}</li>)}</ul>
                <p className="slug-example">{t.slugExample}</p>
              </div>
            )}
          </div>
          <label>
            {t.tags}
            <input
              value={tags}
              readOnly={appendProject}
              onChange={(event) => setTags(event.target.value)}
              placeholder={t.tagsPlaceholder}
            />
          </label>
          <label className="upload-wide">
            {t.description}
            <textarea
              value={description}
              readOnly={appendProject}
              style={{ resize: "none" }}
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
            {embeddedPair ? <p className="field-note">{t.autoHdrType}</p> : <select
              value={masterType}
              onChange={(event) => updateMasterType(event.target.value)}
            >
              {masterTypes.map((type) => (
                <option key={type.value} value={type.value}>
                  {type.label}
                </option>
              ))}
            </select>}
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
              disabled={embeddedPair || (masterType !== "sdr" && masterType !== "custom")}
            >
              <option value="copy">{t.copySourceStream}</option>
              <option value="transcode">{t.transcodeSdr}</option>
            </select>
          </label>
          <label className="upload-wide">
            {t.notes}
            <textarea
              value={notes}
              style={{ resize: "none" }}
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
              disabled={appendProject}
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
            {isHdr && !appendProject && !pairedSdr ? t.defaultSdrMaster : t.defaultMaster}
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
      {isHdr && !pairedSdr && !embeddedPair ? <p className="field-note">{t.automaticSdr}</p> : null}
      <div className="upload-actions">
        <button type="submit" disabled={!canSubmit}>
          {state === "uploading" ? t.uploading : t.uploadVideo}
        </button>
        <div className="upload-progress" aria-live="polite">
          <span style={{ width: `${progress}%` }} />
        </div>
      </div>
      </fieldset>

      {/* ── Status / Result ── */}
      {statusMessage ? (
        <div
          className={
            state === "error" || result?.processingInterrupted || result?.sdrDerivative?.status === "failed" || result?.companionSdr?.status === "failed"
              ? "upload-status error" : "upload-status"
          }
          role="status"
        >
          {/* Drawn once, only when upload and processing both finished without a partial failure. */}
          {state === "success" && !result?.processingInterrupted && result?.sdrDerivative?.status !== "failed" && result?.companionSdr?.status !== "failed" ? (
            <p className="upload-status-done">
              <svg className="upload-done-mark" viewBox="0 0 24 24" aria-hidden="true">
                <circle cx="12" cy="12" r="10" pathLength={1} />
                <path d="m7.5 12.5 3 3 6-6.5" pathLength={1} />
              </svg>
              <span>{statusMessage}</span>
            </p>
          ) : <p>{statusMessage}</p>}
          {result?.sourceFormat ? <VideoFormatInfo source={result.sourceFormat} lang={lang}
            playback={state === "success" ? ({ hdr10: "HDR10", sdr: "SDR", hlg: "HLG", dolby_vision: "Dolby Vision" } as Record<string, string>)[result.master?.type || ""] || result.colorContract?.hlsVideoRange : null} /> : null}
          {/* Name the actual delivery format even when the uploaded archive contains Dolby metadata. */}
          {result?.verification?.conversion?.intent === "imf_rgb_to_hdr10" ? <p>{t.imfConverted}</p> : null}
          {result?.companionSdr?.error ? <p>{result.companionSdr.error}</p> : null}
          {result?.project?.id ? <p><a href={`/upload?projectId=${result.project.id}`}>
            {result.companionSdr?.status === "failed" || result.sdrDerivative?.status === "failed" ? t.addSdr : t.addMaster}
          </a></p> : null}
          {result?.sdrDerivative?.error ? <p>{result.sdrDerivative.error}</p> : null}
          {result?.sdrDerivative?.hlsUrl ? <code>{result.sdrDerivative.hlsUrl}</code> : null}
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
