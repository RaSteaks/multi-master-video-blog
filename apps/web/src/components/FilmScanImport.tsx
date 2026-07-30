"use client";

import {
  useDeferredValue,
  useEffect,
  useId,
  useMemo,
  useRef,
  useState,
  type FormEvent,
  type KeyboardEvent as ReactKeyboardEvent,
  type MouseEvent as ReactMouseEvent,
  type PointerEvent as ReactPointerEvent,
  type ReactNode,
} from "react";
import {
  albumApiRequest,
  uploadAlbumFormData,
} from "@/lib/album-management";

type AlbumOption = {
  id: number;
  title: string;
  published: boolean;
};

type FilmAdjustments = {
  maskMode: "auto" | "manual" | "preset";
  maskRgb: [number, number, number] | null;
  filmBaseSample: { x: number; y: number; sourceId: number } | null;
  exposure: number;
  temperature: number;
  tint: number;
  blackPoint: [number, number, number];
  whitePoint: [number, number, number];
  contrast: number;
  saturation: number;
  highlightRolloff: number;
};

type FilmFrame = {
  id: number;
  sourceId: number;
  crop: { x: number; y: number; width: number; height: number };
  rotation: number;
  sortOrder: number;
  confidence: number;
  reviewStatus: string;
  accepted: boolean;
  published: boolean;
  adjustmentOverrides: Partial<FilmAdjustments>;
  previewAvailable: boolean;
};

type FilmJob = {
  id: number;
  albumId: number;
  status:
    | "uploaded"
    | "analyzing"
    | "review_required"
    | "rendering"
    | "committed"
    | "failed"
    | "canceled";
  scanner: string;
  frameFormat: string;
  filmType: string;
  filmStock: string;
  iso: number;
  process: string;
  pushPull: number;
  rollAdjustments: FilmAdjustments;
  progress: number;
  warnings: string[];
  error: string | null;
  experimentalCompatibility: boolean;
  frames: FilmFrame[];
};

type FilmStockPreset = {
  id: number;
  manufacturer: string;
  model: string;
  film_type: "color-negative" | "bw-negative" | "slide";
  nominal_iso: number;
  recommended_process: "c41" | "e6" | "ecn2" | "bw" | "other" | null;
  scanner: string | null;
  parameters: FilmAdjustments;
  built_in: boolean;
};

const DEFAULT_ADJUSTMENTS: FilmAdjustments = {
  maskMode: "auto",
  maskRgb: null,
  filmBaseSample: null,
  exposure: 0,
  temperature: 0,
  tint: 0,
  blackPoint: [0, 0, 0],
  whitePoint: [1, 1, 1],
  contrast: 0,
  saturation: 0,
  highlightRolloff: 0.25,
};

export function FilmScanImport({
  albums,
  token,
  setToken,
  onCompleted,
}: {
  albums: AlbumOption[];
  token: string;
  setToken: (value: string) => void;
  onCompleted: (message: string) => void;
}) {
  const [albumId, setAlbumId] = useState(String(albums[0]?.id ?? ""));
  const [scanner, setScanner] = useState("hasselblad-x5");
  const [frameFormat, setFrameFormat] = useState("135-full");
  const [filmType, setFilmType] = useState("color-negative");
  const [filmStock, setFilmStock] = useState("Kodak Portra 400");
  const [iso, setIso] = useState(400);
  const [process, setProcess] = useState("c41");
  const [pushPull, setPushPull] = useState(0);
  const [files, setFiles] = useState<File[]>([]);
  const [resumeJobId, setResumeJobId] = useState("");
  const [job, setJob] = useState<FilmJob | null>(null);
  const [busy, setBusy] = useState(false);
  const [progress, setProgress] = useState(0);
  const [error, setError] = useState("");
  const [publish, setPublish] = useState(true);
  const [previewRevision, setPreviewRevision] = useState(0);

  function selectFilmStockPreset(preset: FilmStockPreset) {
    setFilmStock(formatFilmStockPreset(preset));
    setFilmType(preset.film_type);
    setIso(preset.nominal_iso);
    if (preset.recommended_process) setProcess(preset.recommended_process);
    if (preset.scanner) setScanner(preset.scanner);
  }

  useEffect(() => {
    if (!job || !["uploaded", "analyzing"].includes(job.status)) return;
    const timer = window.setInterval(async () => {
      try {
        const response = await albumApiRequest<{ status: string; job: FilmJob }>(
          `/api/albums/${job.albumId}/film-scans/${job.id}`,
          token,
        );
        setJob(response.job);
        if (response.job.status === "review_required") {
          setPreviewRevision((value) => value + 1);
        }
      } catch (cause) {
        setError(cause instanceof Error ? cause.message : "任务状态恢复失败。");
      }
    }, 1400);
    return () => window.clearInterval(timer);
  }, [job, token]);

  async function resumeJob() {
    const normalizedJobId = resumeJobId.trim();
    setError("");
    if (!token.trim()) {
      setError("请输入管理员令牌。");
      return;
    }
    if (!albumId || !/^\d+$/.test(normalizedJobId)) {
      setError("请选择目标相簿并输入有效的任务编号。");
      return;
    }

    setBusy(true);
    try {
      const response = await albumApiRequest<{ status: string; job: FilmJob }>(
        `/api/albums/${albumId}/film-scans/${normalizedJobId}`,
        token,
      );
      setJob(response.job);
      setPreviewRevision((value) => value + 1);
      onCompleted(
        `胶片扫描任务 #${response.job.id} 已恢复到${filmJobLabel(response.job.status)}。`,
      );
    } catch (cause) {
      setError(cause instanceof Error ? cause.message : "胶片扫描任务恢复失败。");
    } finally {
      setBusy(false);
    }
  }

  async function upload(event: FormEvent<HTMLFormElement>) {
    event.preventDefault();
    setError("");
    if (!token.trim()) {
      setError("请输入管理员令牌。");
      return;
    }
    if (!albumId || !files.length) {
      setError("请选择目标相簿和至少一个扫描原档。");
      return;
    }
    const oversized = files.find((file) => file.size > 2 * 1024 ** 3);
    if (oversized) {
      setError(`“${oversized.name}”超过单原档 2 GiB 限制。`);
      return;
    }
    if (files.reduce((sum, file) => sum + file.size, 0) > 4 * 1024 ** 3) {
      setError("本任务原档总量超过 4 GiB。");
      return;
    }

    const body = new FormData();
    body.append(
      "metadata",
      JSON.stringify({
        scanner,
        frameFormat,
        filmType,
        filmStock,
        iso,
        process,
        pushPull,
        adjustments: DEFAULT_ADJUSTMENTS,
      }),
    );
    for (const file of files) body.append("sources", file, file.name);
    setBusy(true);
    setProgress(0);
    try {
      const response = await uploadAlbumFormData<{
        status: string;
        job: FilmJob;
      }>(
        `/api/albums/${albumId}/film-scans`,
        token,
        body,
        setProgress,
      );
      setJob(response.job);
      onCompleted(`胶片扫描任务 #${response.job.id} 已上传，正在自动分帧。`);
    } catch (cause) {
      setError(cause instanceof Error ? cause.message : "胶片扫描上传失败。");
    } finally {
      setBusy(false);
    }
  }

  async function reloadJob() {
    if (!job) return;
    const response = await albumApiRequest<{ status: string; job: FilmJob }>(
      `/api/albums/${job.albumId}/film-scans/${job.id}`,
      token,
    );
    setJob(response.job);
  }

  async function saveRoll(adjustments: FilmAdjustments) {
    if (!job) return;
    setBusy(true);
    setError("");
    try {
      const response = await albumApiRequest<{ status: string; job: FilmJob }>(
        `/api/albums/${job.albumId}/film-scans/${job.id}`,
        token,
        {
          method: "PATCH",
          body: JSON.stringify({ rollAdjustments: adjustments }),
        },
      );
      setJob(response.job);
      for (const frame of response.job.frames) {
        if (!frame.accepted) continue;
        await albumApiRequest(
          `/api/albums/${job.albumId}/film-scans/${job.id}/preview`,
          token,
          {
            method: "POST",
            body: JSON.stringify({ frameId: frame.id }),
          },
        );
      }
      setPreviewRevision((value) => value + 1);
    } catch (cause) {
      setError(cause instanceof Error ? cause.message : "整卷参数保存失败。");
    } finally {
      setBusy(false);
    }
  }

  async function patchFrame(frameId: number, patch: Record<string, unknown>) {
    if (!job) return;
    setBusy(true);
    setError("");
    try {
      await albumApiRequest(
        `/api/albums/${job.albumId}/film-scans/${job.id}/frames/${frameId}`,
        token,
        {
          method: "PATCH",
          body: JSON.stringify(patch),
        },
      );
      await reloadJob();
      setPreviewRevision((value) => value + 1);
    } catch (cause) {
      setError(cause instanceof Error ? cause.message : "帧参数保存失败。");
    } finally {
      setBusy(false);
    }
  }

  async function moveFrame(frameId: number, direction: -1 | 1) {
    if (!job) return;
    const ids = job.frames.map((frame) => frame.id);
    const index = ids.indexOf(frameId);
    const target = index + direction;
    if (index < 0 || target < 0 || target >= ids.length) return;
    [ids[index], ids[target]] = [ids[target], ids[index]];
    setBusy(true);
    try {
      const response = await albumApiRequest<{ status: string; job: FilmJob }>(
        `/api/albums/${job.albumId}/film-scans/${job.id}`,
        token,
        {
          method: "PATCH",
          body: JSON.stringify({ frameOrder: ids }),
        },
      );
      setJob(response.job);
    } catch (cause) {
      setError(cause instanceof Error ? cause.message : "重新排序失败。");
    } finally {
      setBusy(false);
    }
  }

  async function commit() {
    if (!job) return;
    setBusy(true);
    setError("");
    try {
      const response = await albumApiRequest<{
        status: string;
        job: FilmJob;
        createdPhotoIds: number[];
      }>(
        `/api/albums/${job.albumId}/film-scans/${job.id}/commit`,
        token,
        {
          method: "POST",
          body: JSON.stringify({ published: publish }),
        },
      );
      setJob(response.job);
      onCompleted(
        `胶片扫描任务 #${job.id} 已生成 ${response.createdPhotoIds.length} 张相簿照片。`,
      );
    } catch (cause) {
      setError(cause instanceof Error ? cause.message : "生成相簿照片失败。");
      await reloadJob().catch(() => {});
    } finally {
      setBusy(false);
    }
  }

  if (job) {
    return (
      <FilmReview
        job={job}
        token={token}
        busy={busy}
        error={error}
        publish={publish}
        previewRevision={previewRevision}
        onPublish={setPublish}
        onSaveRoll={saveRoll}
        onSavePreset={async (adjustments) => {
          setBusy(true);
          setError("");
          try {
            const [manufacturer, ...modelParts] = job.filmStock.trim().split(/\s+/);
            await albumApiRequest("/api/albums/film-stock-presets", token, {
              method: "POST",
              body: JSON.stringify({
                manufacturer: modelParts.length ? manufacturer : "Custom",
                model: modelParts.length ? modelParts.join(" ") : manufacturer,
                filmType: job.filmType,
                nominalIso: job.iso,
                recommendedProcess: job.process,
                scanner: job.scanner,
                parameters: adjustments,
              }),
            });
            onCompleted(`“${job.filmStock}”的当前参数已保存为自定义预设。`);
          } catch (cause) {
            setError(cause instanceof Error ? cause.message : "预设保存失败。");
          } finally {
            setBusy(false);
          }
        }}
        onPatchFrame={patchFrame}
        onMoveFrame={moveFrame}
        onCommit={commit}
        onRetry={async () => {
          setBusy(true);
          try {
            await albumApiRequest(
              `/api/albums/${job.albumId}/film-scans/${job.id}/retry`,
              token,
              { method: "POST", body: "{}" },
            );
            await reloadJob();
          } catch (cause) {
            setError(cause instanceof Error ? cause.message : "任务重试失败。");
          } finally {
            setBusy(false);
          }
        }}
        onNew={() => {
          setJob(null);
          setFiles([]);
          setProgress(0);
          setError("");
        }}
      />
    );
  }

  return (
    <form className="film-scan-form" onSubmit={upload}>
      <div className="film-scan-intro">
        <div>
          <p className="eyebrow">Experimental scanner workflow</p>
          <h3>从原始扫描到暗房接触印样</h3>
        </div>
        <p>
          自动分帧与去色罩后先进入审核，不会直接公开。FFF/3F 按增强 TIFF
          解码；在取得三台扫描仪真实样本前均标记为实验性兼容。
        </p>
      </div>
      <label className="album-field">
        <span>管理员令牌</span>
        <input
          type="password"
          value={token}
          onChange={(event) => setToken(event.target.value)}
          autoComplete="new-password"
          required
        />
      </label>
      <div className="film-scan-resume">
        <div>
          <strong>继续已有扫描任务</strong>
          <small>输入任务编号，恢复分析进度或返回暗房审核。</small>
        </div>
        <label>
          <span>任务编号</span>
          <input
            type="number"
            min={1}
            step={1}
            inputMode="numeric"
            value={resumeJobId}
            onChange={(event) => setResumeJobId(event.target.value)}
            placeholder="例如 5"
          />
        </label>
        <button
          className="album-action-button"
          type="button"
          disabled={busy || !resumeJobId.trim()}
          onClick={() => void resumeJob()}
        >
          恢复任务
        </button>
      </div>
      <div className="film-scan-fields">
        <SelectField label="目标相簿" value={albumId} onChange={setAlbumId}>
          {albums.map((album) => (
            <option key={album.id} value={album.id}>
              {album.title}{album.published ? "" : "（草稿）"}
            </option>
          ))}
        </SelectField>
        <SelectField label="扫描仪" value={scanner} onChange={setScanner}>
          <option value="hasselblad-x5">Hasselblad X5</option>
          <option value="fujifilm-sp3000">Fujifilm SP-3000</option>
          <option value="noritsu-hs1800">Noritsu HS-1800</option>
        </SelectField>
        <SelectField label="画幅" value={frameFormat} onChange={setFrameFormat}>
          <optgroup label="135">
            <option value="135-full">全格 36×24</option>
            <option value="135-half">半格 24×18</option>
            <option value="135-pano">宽幅</option>
          </optgroup>
          <optgroup label="120">
            <option value="120-645">6×4.5</option>
            <option value="120-66">6×6</option>
            <option value="120-67">6×7</option>
            <option value="120-68">6×8</option>
            <option value="120-69">6×9</option>
          </optgroup>
        </SelectField>
        <SelectField label="胶卷类型" value={filmType} onChange={setFilmType}>
          <option value="color-negative">彩色负片</option>
          <option value="bw-negative">黑白负片</option>
          <option value="slide">E-6 正片</option>
        </SelectField>
        <FilmStockCombobox
          value={filmStock}
          token={token}
          onChange={setFilmStock}
          onSelect={selectFilmStockPreset}
        />
        <label className="album-field">
          <span>ISO</span>
          <input
            type="number"
            min={1}
            max={25600}
            value={iso}
            onChange={(event) => setIso(Number(event.target.value))}
            required
          />
        </label>
        <SelectField label="冲洗工艺" value={process} onChange={setProcess}>
          <option value="c41">C-41</option>
          <option value="e6">E-6</option>
          <option value="ecn2">ECN-2</option>
          <option value="bw">黑白</option>
          <option value="other">其他</option>
        </SelectField>
        <label className="album-field">
          <span>推拉档数</span>
          <input
            type="number"
            min={-5}
            max={5}
            step={0.5}
            value={pushPull}
            onChange={(event) => setPushPull(Number(event.target.value))}
          />
        </label>
      </div>
      <label className="film-scan-drop">
        <input
          type="file"
          multiple
          accept=".fff,.3f,.tif,.tiff,.jpg,.jpeg,image/tiff,image/jpeg"
          onChange={(event) => setFiles(Array.from(event.target.files ?? []))}
          required
        />
        <span>选择 FFF / 3F / TIFF / JPEG 原档</span>
        <small>
          单原档 2 GiB，单任务 4 GiB；支持整条扫描与已逐帧保存的单张扫描。
        </small>
        {files.length ? <strong>{files.length} 个原档 · {formatBytes(files.reduce((sum, file) => sum + file.size, 0))}</strong> : null}
      </label>
      {busy ? <progress max={100} value={progress} /> : null}
      {error ? <p className="album-form-feedback is-error" role="alert">{error}</p> : null}
      <button
        className="album-action-button album-action-button--primary album-submit"
        type="submit"
        disabled={busy || !files.length}
      >
        {busy ? `上传中 ${progress}%` : "上传并开始分析"}
      </button>
    </form>
  );
}

function FilmStockCombobox({
  value,
  token,
  onChange,
  onSelect,
}: {
  value: string;
  token: string;
  onChange: (value: string) => void;
  onSelect: (preset: FilmStockPreset) => void;
}) {
  const rootRef = useRef<HTMLDivElement>(null);
  const observedTokenRef = useRef(token.trim());
  const loadedTokenRef = useRef("");
  const loadingTokenRef = useRef("");
  const requestIdRef = useRef(0);
  const inputId = useId();
  const listboxId = useId();
  const [presets, setPresets] = useState<FilmStockPreset[]>([]);
  const [open, setOpen] = useState(false);
  const [loading, setLoading] = useState(false);
  const [loadError, setLoadError] = useState("");
  const [searchQuery, setSearchQuery] = useState("");
  const [activeIndex, setActiveIndex] = useState(-1);
  const deferredQuery = useDeferredValue(searchQuery);

  const visiblePresets = useMemo(() => {
    const query = normalizeFilmStockSearch(deferredQuery);
    if (!query) return presets.slice(0, 24);
    return presets
      .filter((preset) => filmStockPresetSearchText(preset).includes(query))
      .slice(0, 24);
  }, [deferredQuery, presets]);

  useEffect(() => {
    const currentToken = token.trim();
    if (observedTokenRef.current === currentToken) return;
    observedTokenRef.current = currentToken;
    requestIdRef.current += 1;
    loadedTokenRef.current = "";
    loadingTokenRef.current = "";
    setPresets([]);
    setLoading(false);
    setLoadError("");
  }, [token]);

  useEffect(() => {
    if (!open) return;
    const closeOnOutsidePointer = (event: PointerEvent) => {
      if (!rootRef.current?.contains(event.target as Node)) setOpen(false);
    };
    document.addEventListener("pointerdown", closeOnOutsidePointer);
    return () =>
      document.removeEventListener("pointerdown", closeOnOutsidePointer);
  }, [open]);

  useEffect(() => {
    if (!visiblePresets.length) {
      setActiveIndex(-1);
      return;
    }
    setActiveIndex((index) =>
      index < 0 ? 0 : Math.min(index, visiblePresets.length - 1),
    );
  }, [visiblePresets]);

  async function loadPresets() {
    const currentToken = token.trim();
    if (!currentToken) {
      setLoadError("输入管理员令牌后可搜索服务器预设。");
      return;
    }
    if (loadedTokenRef.current === currentToken) return;
    if (loadingTokenRef.current === currentToken) return;

    const requestId = requestIdRef.current + 1;
    requestIdRef.current = requestId;
    loadingTokenRef.current = currentToken;
    setLoading(true);
    setLoadError("");
    setPresets([]);
    try {
      const response = await albumApiRequest<{
        status: string;
        presets: FilmStockPreset[];
      }>("/api/albums/film-stock-presets", currentToken);
      if (requestIdRef.current !== requestId) return;
      setPresets(response.presets);
      loadedTokenRef.current = currentToken;
    } catch (cause) {
      if (requestIdRef.current !== requestId) return;
      loadedTokenRef.current = "";
      setLoadError(
        cause instanceof Error ? cause.message : "服务器预设加载失败。",
      );
    } finally {
      if (requestIdRef.current === requestId) {
        loadingTokenRef.current = "";
        setLoading(false);
      }
    }
  }

  function openPresetList() {
    setSearchQuery("");
    setOpen(true);
    void loadPresets();
  }

  function choosePreset(preset: FilmStockPreset) {
    onSelect(preset);
    setSearchQuery("");
    setOpen(false);
  }

  function handleKeyDown(event: ReactKeyboardEvent<HTMLInputElement>) {
    if (event.key === "ArrowDown") {
      event.preventDefault();
      if (!open) openPresetList();
      setActiveIndex((index) =>
        Math.min(index + 1, Math.max(visiblePresets.length - 1, 0)),
      );
      return;
    }
    if (event.key === "ArrowUp") {
      event.preventDefault();
      if (!open) openPresetList();
      setActiveIndex((index) =>
        index <= 0 ? Math.max(visiblePresets.length - 1, 0) : index - 1,
      );
      return;
    }
    if (event.key === "Home" && open && visiblePresets.length) {
      event.preventDefault();
      setActiveIndex(0);
      return;
    }
    if (event.key === "End" && open && visiblePresets.length) {
      event.preventDefault();
      setActiveIndex(visiblePresets.length - 1);
      return;
    }
    if (
      event.key === "Enter" &&
      open &&
      activeIndex >= 0 &&
      visiblePresets[activeIndex]
    ) {
      event.preventDefault();
      choosePreset(visiblePresets[activeIndex]);
      return;
    }
    if (event.key === "Escape" && open) {
      event.preventDefault();
      setOpen(false);
    }
  }

  const activePreset = visiblePresets[activeIndex];
  const helpText = loading
    ? "正在加载服务器预设…"
    : loadError
      ? `${loadError} 仍可自由输入。`
      : loadedTokenRef.current
        ? `${presets.length} 项服务器预设 · 也可直接输入新型号`
        : "点击或聚焦输入框加载服务器预设，也可直接输入";

  return (
    <div className="album-field film-stock-field" ref={rootRef}>
      <span id={`${inputId}-label`}>胶卷型号</span>
      <div className="film-stock-combobox">
        <input
          id={inputId}
          role="combobox"
          aria-labelledby={`${inputId}-label`}
          aria-autocomplete="list"
          aria-expanded={open}
          aria-controls={listboxId}
          aria-activedescendant={
            open && activePreset
              ? `${listboxId}-option-${activePreset.id}`
              : undefined
          }
          value={value}
          onFocus={openPresetList}
          onChange={(event) => {
            const nextValue = event.target.value;
            onChange(nextValue);
            setSearchQuery(nextValue);
            setOpen(true);
            setActiveIndex(0);
            void loadPresets();
          }}
          onKeyDown={handleKeyDown}
          maxLength={160}
          required
        />
        <button
          type="button"
          className="film-stock-toggle"
          aria-label={open ? "收起胶卷预设" : "展开胶卷预设"}
          aria-expanded={open}
          aria-controls={listboxId}
          onClick={() => {
            if (open) {
              setOpen(false);
            } else {
              openPresetList();
            }
          }}
        >
          <span aria-hidden="true">⌄</span>
        </button>
        {open ? (
          <div
            className="film-stock-listbox"
            id={listboxId}
            role="listbox"
            aria-label="服务器胶卷预设"
          >
            {loading ? (
              <p className="film-stock-list-state" role="status">
                正在读取服务器预设…
              </p>
            ) : loadError ? (
              <p className="film-stock-list-state is-error" role="status">
                {loadError}
                <span>当前输入仍会作为自定义型号保存。</span>
              </p>
            ) : visiblePresets.length ? (
              visiblePresets.map((preset, index) => {
                const label = formatFilmStockPreset(preset);
                return (
                  <div
                    id={`${listboxId}-option-${preset.id}`}
                    className={`film-stock-option${index === activeIndex ? " is-active" : ""}`}
                    role="option"
                    aria-selected={label === value}
                    key={preset.id}
                    onPointerMove={() => setActiveIndex(index)}
                    onPointerDown={(event) => {
                      event.preventDefault();
                      choosePreset(preset);
                    }}
                  >
                    <span className="film-stock-option-copy">
                      <strong>{label}</strong>
                      <small>
                        {formatFilmType(preset.film_type)} · ISO{" "}
                        {preset.nominal_iso}
                        {preset.recommended_process
                          ? ` · ${preset.recommended_process.toUpperCase()}`
                          : ""}
                        {preset.scanner
                          ? ` · ${formatFilmScanner(preset.scanner)}`
                          : ""}
                      </small>
                    </span>
                    <span
                      className={`film-stock-option-kind${preset.built_in ? "" : " is-custom"}`}
                    >
                      {preset.built_in ? "内置" : "自定义"}
                    </span>
                  </div>
                );
              })
            ) : (
              <p className="film-stock-list-state" role="status">
                未找到匹配预设
                <span>继续输入即可使用“{value || "新胶卷型号"}”。</span>
              </p>
            )}
          </div>
        ) : null}
      </div>
      <small className={loadError ? "is-error" : undefined}>{helpText}</small>
    </div>
  );
}

function FilmReview({
  job,
  token,
  busy,
  error,
  publish,
  previewRevision,
  onPublish,
  onSaveRoll,
  onSavePreset,
  onPatchFrame,
  onMoveFrame,
  onCommit,
  onRetry,
  onNew,
}: {
  job: FilmJob;
  token: string;
  busy: boolean;
  error: string;
  publish: boolean;
  previewRevision: number;
  onPublish: (value: boolean) => void;
  onSaveRoll: (value: FilmAdjustments) => Promise<void>;
  onSavePreset: (value: FilmAdjustments) => Promise<void>;
  onPatchFrame: (frameId: number, patch: Record<string, unknown>) => Promise<void>;
  onMoveFrame: (frameId: number, direction: -1 | 1) => Promise<void>;
  onCommit: () => Promise<void>;
  onRetry: () => Promise<void>;
  onNew: () => void;
}) {
  const [adjustments, setAdjustments] = useState(job.rollAdjustments);
  useEffect(() => setAdjustments(job.rollAdjustments), [job.rollAdjustments]);
  const pendingConfirmation = job.frames.filter(
    (frame) =>
      frame.accepted &&
      frame.confidence < 0.85 &&
      frame.reviewStatus !== "confirmed",
  ).length;

  return (
    <div className="film-review">
      <header className="film-review-header">
        <div>
          <p className="eyebrow">Darkroom contact sheet · #{job.id}</p>
          <h3>{job.filmStock}</h3>
          <p>{job.frameFormat} · {job.process.toUpperCase()} · {formatFilmScanner(job.scanner)}</p>
        </div>
        <div className={`film-job-state is-${job.status}`}>
          <span>{filmJobLabel(job.status)}</span>
          <strong>{job.progress}%</strong>
        </div>
      </header>

      {["uploaded", "analyzing", "rendering"].includes(job.status) ? (
        <div className="film-processing" role="status">
          <div className="film-processing-reel" aria-hidden="true" />
          <div>
            <strong>{job.status === "rendering" ? "正在生成成片" : "正在分析片基与画幅"}</strong>
            <p>任务状态已持久化；刷新页面或 API 重启后可以恢复。</p>
            <progress max={100} value={job.progress} />
          </div>
        </div>
      ) : null}

      {job.status === "failed" ? (
        <div className="film-review-error" role="alert">
          <strong>处理失败，原档已保留</strong>
          <p>{job.error}</p>
          <button className="album-action-button" type="button" onClick={() => void onRetry()} disabled={busy}>重试分析</button>
        </div>
      ) : null}

      {job.status === "review_required" ? (
        <>
          <FilmRollControls
            value={adjustments}
            disabled={busy}
            onChange={setAdjustments}
            onSave={() => void onSaveRoll(adjustments)}
            onSavePreset={() => void onSavePreset(adjustments)}
          />
          {job.warnings.length ? (
            <div className="film-warning-list">
              <strong>审核提示</strong>
              <ul>{job.warnings.map((warning, index) => <li key={`${warning}-${index}`}>{warning}</li>)}</ul>
            </div>
          ) : null}
          <div className="film-contact-sheet">
            {job.frames.map((frame, index) => (
              <FilmFrameCard
                key={frame.id}
                job={job}
                frame={frame}
                index={index}
                token={token}
                disabled={busy}
                previewRevision={previewRevision}
                onPatch={(patch) => onPatchFrame(frame.id, patch)}
                onMove={(direction) => onMoveFrame(frame.id, direction)}
                sampleEnabled={
                  job.filmType === "color-negative" &&
                  adjustments.maskMode === "manual"
                }
                onSampleFilmBase={(point) => {
                  const next = {
                    ...adjustments,
                    maskMode: "manual" as const,
                    filmBaseSample: { ...point, sourceId: frame.sourceId },
                  };
                  setAdjustments(next);
                  return onSaveRoll(next);
                }}
              />
            ))}
          </div>
          <footer className="film-commit-bar">
            <label className="album-switch">
              <input type="checkbox" checked={publish} onChange={(event) => onPublish(event.target.checked)} />
              <span>
                <strong>{publish ? "提交为公开照片" : "提交为草稿"}</strong>
                <small>可在相簿管理模式中逐张修改。</small>
              </span>
            </label>
            <div>
              <span>{job.frames.filter((frame) => frame.accepted).length} 帧保留</span>
              {pendingConfirmation ? <strong>{pendingConfirmation} 帧待确认</strong> : null}
              <button
                className="album-action-button album-action-button--primary"
                type="button"
                disabled={busy || pendingConfirmation > 0}
                onClick={() => void onCommit()}
              >
                {busy ? "处理中…" : "生成 SDR / PQ / HLG 并写入相簿"}
              </button>
            </div>
          </footer>
        </>
      ) : null}

      {job.status === "committed" ? (
        <div className="film-complete">
          <strong>冲印完成</strong>
          <p>照片与可用的 SDR、PQ、HLG 版本已经写入目标相簿。</p>
          <button className="album-action-button" type="button" onClick={onNew}>导入下一卷</button>
        </div>
      ) : null}
      {error ? <p className="album-form-feedback is-error" role="alert">{error}</p> : null}
    </div>
  );
}

function FilmRollControls({
  value,
  disabled,
  onChange,
  onSave,
  onSavePreset,
}: {
  value: FilmAdjustments;
  disabled: boolean;
  onChange: (value: FilmAdjustments) => void;
  onSave: () => void;
  onSavePreset: () => void;
}) {
  function set<K extends keyof FilmAdjustments>(key: K, next: FilmAdjustments[K]) {
    onChange({ ...value, [key]: next });
  }
  const mask = value.maskRgb ?? [0.82, 0.62, 0.4];
  return (
    <section className="film-roll-controls">
      <header>
        <div><p className="eyebrow">Whole roll baseline</p><h4>整卷去色罩与色彩基准</h4></div>
        <div className="film-roll-actions">
          <button className="album-action-button" type="button" disabled={disabled} onClick={onSavePreset}>保存为自定义预设</button>
          <button className="album-action-button" type="button" disabled={disabled} onClick={onSave}>应用到整卷并刷新预览</button>
        </div>
      </header>
      <div className="film-control-grid">
        <SelectField label="去色罩" value={value.maskMode} onChange={(next) => set("maskMode", next as FilmAdjustments["maskMode"])}>
          <option value="auto">自动片基采样</option>
          <option value="manual">手动 RGB</option>
          <option value="preset">扫描仪 + 胶卷预设</option>
        </SelectField>
        {value.maskMode === "manual" ? (
          <div>
            <div className="film-mask-rgb">
              {mask.map((channel, index) => (
                <label key={index}>
                  <span>{["R", "G", "B"][index]}</span>
                  <input type="number" min={0} max={1} step={0.01} value={channel} onChange={(event) => {
                    const next = [...mask] as [number, number, number];
                    next[index] = Number(event.target.value);
                    set("maskRgb", next);
                  }} />
                </label>
              ))}
            </div>
            <small>
              {value.filmBaseSample
                ? `片基取样：源 #${value.filmBaseSample.sourceId} · ${value.filmBaseSample.x.toFixed(3)}, ${value.filmBaseSample.y.toFixed(3)}`
                : "可在下方接触印样的裁切框外点按片基，或直接输入 RGB。"}
            </small>
          </div>
        ) : null}
        <RangeField label="曝光" value={value.exposure} min={-3} max={3} step={0.1} onChange={(next) => set("exposure", next)} />
        <RangeField label="色温" value={value.temperature} min={-1} max={1} step={0.02} onChange={(next) => set("temperature", next)} />
        <RangeField label="色调" value={value.tint} min={-1} max={1} step={0.02} onChange={(next) => set("tint", next)} />
        <RangeField label="对比度" value={value.contrast} min={-1} max={1} step={0.02} onChange={(next) => set("contrast", next)} />
        <RangeField label="饱和度" value={value.saturation} min={-1} max={1.5} step={0.02} onChange={(next) => set("saturation", next)} />
        <RangeField label="高光滚降" value={value.highlightRolloff} min={0} max={1} step={0.02} onChange={(next) => set("highlightRolloff", next)} />
        <ChannelPoints
          label="通道黑点"
          value={value.blackPoint}
          onChange={(next) => set("blackPoint", next)}
        />
        <ChannelPoints
          label="通道白点"
          value={value.whitePoint}
          onChange={(next) => set("whitePoint", next)}
        />
      </div>
    </section>
  );
}

function ChannelPoints({
  label,
  value,
  onChange,
}: {
  label: string;
  value: [number, number, number];
  onChange: (value: [number, number, number]) => void;
}) {
  return (
    <fieldset className="film-channel-points">
      <legend>{label}</legend>
      {value.map((channel, index) => (
        <label key={index}>
          <span>{["R", "G", "B"][index]}</span>
          <input
            type="number"
            min={0}
            max={1}
            step={0.01}
            value={channel}
            onChange={(event) => {
              const next = [...value] as [number, number, number];
              next[index] = Number(event.target.value);
              onChange(next);
            }}
          />
        </label>
      ))}
    </fieldset>
  );
}

function FilmFrameCard({
  job,
  frame,
  index,
  token,
  disabled,
  previewRevision,
  onPatch,
  onMove,
  sampleEnabled,
  onSampleFilmBase,
}: {
  job: FilmJob;
  frame: FilmFrame;
  index: number;
  token: string;
  disabled: boolean;
  previewRevision: number;
  onPatch: (patch: Record<string, unknown>) => Promise<void>;
  onMove: (direction: -1 | 1) => Promise<void>;
  sampleEnabled: boolean;
  onSampleFilmBase: (point: { x: number; y: number }) => Promise<void>;
}) {
  const [crop, setCrop] = useState(frame.crop);
  const [exposure, setExposure] = useState(frame.adjustmentOverrides.exposure ?? 0);
  const [preview, setPreview] = useState<string | null>(null);
  const [sourcePreview, setSourcePreview] = useState<string | null>(null);
  const [cropGesture, setCropGesture] = useState<{
    mode: "move" | "resize";
    x: number;
    y: number;
    crop: FilmFrame["crop"];
  } | null>(null);
  useEffect(() => setCrop(frame.crop), [frame.crop]);
  useEffect(() => {
    let objectUrl: string | null = null;
    let canceled = false;
    fetch(
      `/api/albums/${job.albumId}/film-scans/${job.id}/frames/${frame.id}/preview?v=${previewRevision}`,
      { headers: { Authorization: `Bearer ${token.trim()}` }, cache: "no-store" },
    )
      .then((response) => {
        if (!response.ok) throw new Error("预览载入失败");
        return response.blob();
      })
      .then((blob) => {
        if (canceled) return;
        objectUrl = URL.createObjectURL(blob);
        setPreview(objectUrl);
      })
      .catch(() => setPreview(null));
    return () => {
      canceled = true;
      if (objectUrl) URL.revokeObjectURL(objectUrl);
    };
  }, [frame.id, job.albumId, job.id, previewRevision, token]);
  useEffect(() => {
    let objectUrl: string | null = null;
    let canceled = false;
    fetch(
      `/api/albums/${job.albumId}/film-scans/${job.id}/sources/${frame.sourceId}/preview`,
      { headers: { Authorization: `Bearer ${token.trim()}` }, cache: "no-store" },
    )
      .then((response) => {
        if (!response.ok) throw new Error("原档接触印样载入失败");
        return response.blob();
      })
      .then((blob) => {
        if (canceled) return;
        objectUrl = URL.createObjectURL(blob);
        setSourcePreview(objectUrl);
      })
      .catch(() => setSourcePreview(null));
    return () => {
      canceled = true;
      if (objectUrl) URL.revokeObjectURL(objectUrl);
    };
  }, [frame.sourceId, job.albumId, job.id, token]);

  function startCropGesture(
    event: ReactPointerEvent<HTMLElement>,
    mode: "move" | "resize",
  ) {
    event.preventDefault();
    event.stopPropagation();
    event.currentTarget.setPointerCapture(event.pointerId);
    setCropGesture({
      mode,
      x: event.clientX,
      y: event.clientY,
      crop: { ...crop },
    });
  }

  function moveCropGesture(event: ReactPointerEvent<HTMLDivElement>) {
    if (!cropGesture) return;
    const rect = event.currentTarget.getBoundingClientRect();
    const dx = (event.clientX - cropGesture.x) / Math.max(1, rect.width);
    const dy = (event.clientY - cropGesture.y) / Math.max(1, rect.height);
    if (cropGesture.mode === "move") {
      setCrop({
        ...cropGesture.crop,
        x: Math.max(0, Math.min(1 - cropGesture.crop.width, cropGesture.crop.x + dx)),
        y: Math.max(0, Math.min(1 - cropGesture.crop.height, cropGesture.crop.y + dy)),
      });
    } else {
      setCrop({
        ...cropGesture.crop,
        width: Math.max(
          0.01,
          Math.min(1 - cropGesture.crop.x, cropGesture.crop.width + dx),
        ),
        height: Math.max(
          0.01,
          Math.min(1 - cropGesture.crop.y, cropGesture.crop.height + dy),
        ),
      });
    }
  }

  function sampleFilmBase(event: ReactMouseEvent<HTMLDivElement>) {
    if (!sampleEnabled || disabled) return;
    if ((event.target as HTMLElement).closest(".film-crop-box")) return;
    const rect = event.currentTarget.getBoundingClientRect();
    const point = {
      x: Math.max(0, Math.min(1, (event.clientX - rect.left) / Math.max(1, rect.width))),
      y: Math.max(0, Math.min(1, (event.clientY - rect.top) / Math.max(1, rect.height))),
    };
    void onSampleFilmBase(point);
  }

  return (
    <article className={`film-frame${frame.accepted ? "" : " is-rejected"}`}>
      <div className="film-frame-image">
        {preview ? <img src={preview} alt={`胶片帧 ${index + 1} 审核预览`} /> : <span>正在载入预览…</span>}
        <div className="film-frame-badges">
          <strong>#{String(index + 1).padStart(2, "0")}</strong>
          <span className={frame.confidence < 0.85 ? "is-low" : ""}>{Math.round(frame.confidence * 100)}%</span>
        </div>
      </div>
      <div className="film-frame-editor">
        {sourcePreview ? (
          <div
            className={`film-crop-stage${sampleEnabled ? " is-sampling-film-base" : ""}`}
            onPointerMove={moveCropGesture}
            onPointerUp={() => setCropGesture(null)}
            onPointerCancel={() => setCropGesture(null)}
            onClick={sampleFilmBase}
          >
            <img src={sourcePreview} alt="" draggable={false} />
            <div
              className="film-crop-box"
              style={{
                left: `${crop.x * 100}%`,
                top: `${crop.y * 100}%`,
                width: `${crop.width * 100}%`,
                height: `${crop.height * 100}%`,
              }}
              onPointerDown={(event) => startCropGesture(event, "move")}
            >
              <i
                aria-hidden="true"
                onPointerDown={(event) => startCropGesture(event, "resize")}
              />
            </div>
          </div>
        ) : null}
        {sampleEnabled ? (
          <small className="film-base-sample-hint">
            点按裁切框外的透明片基区域，将自动读取 RGB 色罩并应用到整卷。
          </small>
        ) : null}
        <div className="film-frame-actions">
          <button type="button" disabled={disabled || index === 0} onClick={() => void onMove(-1)} aria-label="前移">←</button>
          <button type="button" disabled={disabled || index === job.frames.length - 1} onClick={() => void onMove(1)} aria-label="后移">→</button>
          <button type="button" disabled={disabled} onClick={() => void onPatch({ rotation: (frame.rotation + 90) % 360 })}>旋转</button>
          <button type="button" disabled={disabled} onClick={() => void onPatch({ action: "split", splitAt: 0.5 })}>一分为二</button>
          <button type="button" disabled={disabled || index === job.frames.length - 1} onClick={() => void onPatch({ action: "merge-next" })}>合并下一帧</button>
          <button type="button" disabled={disabled} onClick={() => void onPatch({ accepted: !frame.accepted })}>{frame.accepted ? "排除" : "恢复"}</button>
        </div>
        <div className="film-crop-fields">
          {(["x", "y", "width", "height"] as const).map((key) => (
            <label key={key}>
              <span>{key}</span>
              <input type="number" min={0} max={1} step={0.001} value={crop[key]} onChange={(event) => setCrop({ ...crop, [key]: Number(event.target.value) })} />
            </label>
          ))}
        </div>
        <RangeField label="单帧曝光覆盖" value={exposure} min={-3} max={3} step={0.1} onChange={setExposure} />
        <button
          className="album-action-button"
          type="button"
          disabled={disabled}
          onClick={() => void onPatch({
            crop,
            adjustmentOverrides: { ...frame.adjustmentOverrides, exposure },
            confirmed: true,
          })}
        >
          保存裁切与单帧参数
        </button>
      </div>
    </article>
  );
}

function SelectField({
  label,
  value,
  onChange,
  children,
}: {
  label: string;
  value: string;
  onChange: (value: string) => void;
  children: ReactNode;
}) {
  return (
    <label className="album-field">
      <span>{label}</span>
      <select value={value} onChange={(event) => onChange(event.target.value)} required>
        {children}
      </select>
    </label>
  );
}

function RangeField({
  label,
  value,
  min,
  max,
  step,
  onChange,
}: {
  label: string;
  value: number;
  min: number;
  max: number;
  step: number;
  onChange: (value: number) => void;
}) {
  return (
    <label className="film-range">
      <span>{label}<output>{value.toFixed(2)}</output></span>
      <input type="range" value={value} min={min} max={max} step={step} onChange={(event) => onChange(Number(event.target.value))} />
    </label>
  );
}

function formatFilmStockPreset(preset: FilmStockPreset) {
  return `${preset.manufacturer} ${preset.model}`.trim();
}

function normalizeFilmStockSearch(value: string) {
  return value
    .normalize("NFKC")
    .trim()
    .toLocaleLowerCase("zh-CN")
    .replace(/\s+/g, " ");
}

function filmStockPresetSearchText(preset: FilmStockPreset) {
  return normalizeFilmStockSearch(
    [
      preset.manufacturer,
      preset.model,
      preset.nominal_iso,
      formatFilmType(preset.film_type),
      preset.recommended_process?.toUpperCase() || "",
      preset.scanner ? formatFilmScanner(preset.scanner) : "",
      preset.built_in ? "内置" : "自定义",
    ].join(" "),
  );
}

function formatFilmType(filmType: FilmStockPreset["film_type"]) {
  if (filmType === "color-negative") return "彩色负片";
  if (filmType === "bw-negative") return "黑白负片";
  return "E-6 正片";
}

function formatBytes(bytes: number) {
  if (bytes >= 1024 ** 3) return `${(bytes / 1024 ** 3).toFixed(2)} GiB`;
  return `${(bytes / 1024 ** 2).toFixed(1)} MiB`;
}

function formatFilmScanner(scanner: string) {
  if (scanner === "hasselblad-x5") return "Hasselblad X5";
  if (scanner === "fujifilm-sp3000") return "Fujifilm SP-3000";
  if (scanner === "noritsu-hs1800") return "Noritsu HS-1800";
  return scanner;
}

function filmJobLabel(status: FilmJob["status"]) {
  return {
    uploaded: "已上传",
    analyzing: "自动分析",
    review_required: "待审核",
    rendering: "生成成片",
    committed: "已写入相簿",
    failed: "失败",
    canceled: "已取消",
  }[status];
}
