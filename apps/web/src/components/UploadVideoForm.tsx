"use client";

import { FormEvent, useMemo, useState } from "react";

type UploadState = "idle" | "uploading" | "success" | "error";
type SourceKind = "embedded" | "master_package";

type UploadResponse = {
  status: string;
  hlsUrl?: string;
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

const sourceModes = [
  {
    value: "embedded",
    title: "Embedded MP4 / MOV",
    detail: "Upload a browser-deliverable video. Dolby Vision is detected from embedded DOVI/RPU stream metadata.",
  },
  {
    value: "master_package",
    title: "DV Master / IMF / ProRes Package",
    detail: "Upload the full folder/package. XML sidecars, RPU files, MXF, IMF, and primary essence are scanned together.",
  },
] satisfies Array<{ value: SourceKind; title: string; detail: string }>;

function defaultMasterLabel(sourceKind: SourceKind, masterType: string) {
  const baseLabel = masterTypes.find((item) => item.value === masterType)?.label || "Custom";
  return sourceKind === "master_package" ? `${baseLabel} Master` : baseLabel;
}

export function UploadVideoForm() {
  const [token, setToken] = useState("");
  const [title, setTitle] = useState("");
  const [slug, setSlug] = useState("");
  const [description, setDescription] = useState("");
  const [tags, setTags] = useState("");
  const [sourceKind, setSourceKind] = useState<SourceKind>("embedded");
  const [masterType, setMasterType] = useState("sdr");
  const [label, setLabel] = useState("SDR");
  const [mode, setMode] = useState("transcode");
  const [notes, setNotes] = useState("");
  const [published, setPublished] = useState(true);
  const [isDefault, setIsDefault] = useState(true);
  const [overwrite, setOverwrite] = useState(false);
  const [video, setVideo] = useState<File | null>(null);
  const [masterPackageFiles, setMasterPackageFiles] = useState<File[]>([]);
  const [cover, setCover] = useState<File | null>(null);
  const [poster, setPoster] = useState<File | null>(null);
  const [dolbyXmlClipName, setDolbyXmlClipName] = useState("");
  const [state, setState] = useState<UploadState>("idle");
  const [progress, setProgress] = useState(0);
  const [message, setMessage] = useState("");
  const [result, setResult] = useState<UploadResponse | null>(null);

  const selectedSourceMode = sourceModes.find((item) => item.value === sourceKind) || sourceModes[0];
  const sourceReady = sourceKind === "embedded" ? Boolean(video) : masterPackageFiles.length > 0;
  const canSubmit = useMemo(
    () => Boolean(token.trim() && title.trim() && slug.trim() && sourceReady && state !== "uploading"),
    [slug, sourceReady, state, title, token],
  );

  function updateSourceKind(value: SourceKind) {
    setSourceKind(value);
    setProgress(0);
    setMessage("");
    setResult(null);
    if (value === "embedded") {
      setMasterPackageFiles([]);
      setMasterType("sdr");
      setLabel(defaultMasterLabel(value, "sdr"));
      setMode("transcode");
      return;
    }

    setVideo(null);
    setMasterType("dolby_vision");
    setLabel(defaultMasterLabel(value, "dolby_vision"));
    setMode("copy");
  }

  function updateMasterType(value: string) {
    setMasterType(value);
    setLabel(defaultMasterLabel(sourceKind, value));
    if (value === "dolby_vision") {
      setMode("copy");
      return;
    }

    if (value === "sdr") {
      setMode("transcode");
      return;
    }

    setMode("copy");
  }

  function submit(event: FormEvent<HTMLFormElement>) {
    event.preventDefault();
    if (!canSubmit) return;

    setState("uploading");
    setProgress(0);
    setMessage("Uploading and scanning source metadata...");
    setResult(null);

    const form = new FormData();
    form.append("sourceKind", sourceKind);
    if (sourceKind === "embedded" && video) {
      form.append("video", video);
    }

    if (sourceKind === "master_package") {
      for (const file of masterPackageFiles) {
        const relativePath = (file as File & { webkitRelativePath?: string }).webkitRelativePath || file.name;
        form.append("masterPackage", file, relativePath);
      }
    }

    if (cover) form.append("cover", cover);
    if (poster) form.append("poster", poster);
    form.append("dolbyXmlClipName", dolbyXmlClipName.trim());
    form.append("title", title.trim());
    form.append("slug", slug.trim());
    form.append("description", description.trim());
    form.append("tags", tags.trim());
    form.append("masterType", masterType);
    form.append("label", label.trim() || masterTypes.find((item) => item.value === masterType)?.label || "Video");
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
        payload = request.responseText ? JSON.parse(request.responseText) : null;
      } catch {
        payload = null;
      }

      if (request.status >= 200 && request.status < 300) {
        setState("success");
        setProgress(100);
        setResult(payload);
        setMessage("Upload complete. Metadata was detected by the server.");
        return;
      }

      setState("error");
      setMessage(payload?.error || `Upload failed with HTTP ${request.status}.`);
    };

    request.onerror = () => {
      setState("error");
      setMessage("Upload failed before the server responded.");
    };

    request.send(form);
  }

  const projectHref = result?.project?.slug ? `/videos/${result.project.slug}` : null;
  const packageSummary =
    masterPackageFiles.length > 0
      ? `${masterPackageFiles.length} files selected`
      : "Select the complete Dolby Vision package folder.";

  return (
    <form className="upload-form" onSubmit={submit}>
      <section className="upload-panel">
        <h2>Access</h2>
        <label>
          Upload token
          <input
            type="password"
            value={token}
            onChange={(event) => setToken(event.target.value)}
            autoComplete="off"
            placeholder="UPLOAD_API_TOKEN"
            required
          />
        </label>
      </section>

      <section className="upload-panel">
        <h2>Source</h2>
        <div className="upload-source-grid" role="radiogroup" aria-label="Video source type">
          {sourceModes.map((item) => (
            <label
              className={item.value === sourceKind ? "source-mode active" : "source-mode"}
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
            <label className="upload-wide">
              Source video
              <input
                type="file"
                accept="video/*,.mov,.mkv,.mp4,.m4v"
                onChange={(event) => setVideo(event.target.files?.[0] || null)}
                required
              />
            </label>
          ) : (
            <>
              <label className="upload-wide">
                Complete master package folder
                <input
                  type="file"
                  multiple
                  {...({ webkitdirectory: "", directory: "" } as DirectoryInputProps)}
                  onChange={(event) => setMasterPackageFiles(Array.from(event.target.files || []))}
                  required
                />
              </label>
              <label className="upload-wide">
                XML clip name
                <input
                  value={dolbyXmlClipName}
                  onChange={(event) => setDolbyXmlClipName(event.target.value)}
                  placeholder="Optional clip/shot name inside Dolby XML"
                />
              </label>
            </>
          )}

          <label>
            Cover image
            <input type="file" accept="image/*" onChange={(event) => setCover(event.target.files?.[0] || null)} />
          </label>
          <label>
            Poster image
            <input type="file" accept="image/*" onChange={(event) => setPoster(event.target.files?.[0] || null)} />
          </label>
          <div className="upload-source-note">
            <strong>{selectedSourceMode.title}</strong>
            <span>{sourceKind === "embedded" ? "No manual Dolby metadata is accepted for this path." : packageSummary}</span>
          </div>
        </div>
      </section>

      <section className="upload-panel">
        <h2>Metadata</h2>
        <div className="upload-grid">
          <label>
            Title
            <input value={title} onChange={(event) => setTitle(event.target.value)} required />
          </label>
          <label>
            Slug
            <input
              value={slug}
              onChange={(event) => setSlug(event.target.value)}
              pattern="[a-z0-9]+(?:-[a-z0-9]+)*"
              placeholder="dolby-vision-test"
              required
            />
          </label>
          <label>
            Tags
            <input value={tags} onChange={(event) => setTags(event.target.value)} placeholder="dolby, hdr, test" />
          </label>
          <label className="upload-wide">
            Description
            <textarea value={description} onChange={(event) => setDescription(event.target.value)} rows={4} />
          </label>
        </div>
      </section>

      <section className="upload-panel">
        <h2>Master</h2>
        <div className="upload-grid">
          <label>
            Master type
            <select value={masterType} onChange={(event) => updateMasterType(event.target.value)}>
              {masterTypes.map((type) => (
                <option key={type.value} value={type.value}>
                  {type.label}
                </option>
              ))}
            </select>
          </label>
          <label>
            Label
            <input value={label} onChange={(event) => setLabel(event.target.value)} />
          </label>
          <label>
            HLS mode
            <select value={mode} onChange={(event) => setMode(event.target.value)} disabled={masterType === "dolby_vision"}>
              <option value="copy">Copy source stream</option>
              <option value="transcode">Transcode to H.264 SDR</option>
            </select>
          </label>
          <label className="upload-wide">
            Notes
            <textarea value={notes} onChange={(event) => setNotes(event.target.value)} rows={4} />
          </label>
        </div>

        <div className="upload-checks">
          <label>
            <input type="checkbox" checked={published} onChange={(event) => setPublished(event.target.checked)} />
            Published
          </label>
          <label>
            <input type="checkbox" checked={isDefault} onChange={(event) => setIsDefault(event.target.checked)} />
            Default master
          </label>
          <label>
            <input type="checkbox" checked={overwrite} onChange={(event) => setOverwrite(event.target.checked)} />
            Overwrite existing HLS
          </label>
        </div>
      </section>

      <div className="upload-actions">
        <button type="submit" disabled={!canSubmit}>
          {state === "uploading" ? "Uploading..." : "Upload Video"}
        </button>
        <div className="upload-progress" aria-live="polite">
          <span style={{ width: `${progress}%` }} />
        </div>
      </div>

      {message ? (
        <div className={state === "error" ? "upload-status error" : "upload-status"} role="status">
          <p>{message}</p>
          {result?.masterPackage ? (
            <code>
              package={result.masterPackage.fileCount} files, sidecars={result.masterPackage.sidecarCount}, source=
              {result.masterPackage.sourceFile}
            </code>
          ) : null}
          {result?.hlsUrl ? <code>{result.hlsUrl}</code> : null}
          {projectHref ? <a href={projectHref}>Open video page</a> : null}
        </div>
      ) : null}
    </form>
  );
}
