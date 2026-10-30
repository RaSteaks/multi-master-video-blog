"use client";

import { useEffect, useRef, useState, type FormEvent } from "react";
import { useAuthorSession } from "@/lib/author-session";
import { isWebsiteUrl, projectRequest, readSavedProject, type WebsiteProject } from "@/lib/external-projects";
import { AuthorSignIn } from "./AuthorSignIn";
import { SiteDialog } from "./SiteDialog";
import { ProjectPreview } from "./ProjectPreview";
import { ProjectViewer } from "./ProjectViewer";
import styles from "./Projects.module.css";

export function ProjectEditor({ project, onClose, onSaved }: {
  project: WebsiteProject | null; onClose: () => void; onSaved: (project: WebsiteProject) => void;
}) {
  const session = useAuthorSession();
  const [values, setValues] = useState(() => ({
    title: project?.title || "", description: project?.description || "", url: project?.url || "",
    preview_url: project?.preview_url || "", preview_enabled: project?.preview_enabled ?? true,
    open_mode: project?.open_mode || "iframe", sort_order: project?.sort_order || 0,
  }));
  const [cover, setCover] = useState<File | null>(null);
  const [coverUrl, setCoverUrl] = useState<string>();
  const [removeCover, setRemoveCover] = useState(false);
  const [dirty, setDirty] = useState(false);
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState("");
  const [errors, setErrors] = useState<Record<string, string>>({});
  const [discard, setDiscard] = useState(false);
  const [login, setLogin] = useState(false);
  const [preview, setPreview] = useState(false);
  const [viewer, setViewer] = useState(false);
  const formRef = useRef<HTMLFormElement>(null);
  const saving = useRef(false);

  useEffect(() => {
    if (!cover) { setCoverUrl(undefined); return; }
    const url = URL.createObjectURL(cover);
    setCoverUrl(url);
    return () => URL.revokeObjectURL(url);
  }, [cover]);
  useEffect(() => {
    if (!dirty) return;
    const leave = (event: BeforeUnloadEvent) => { event.preventDefault(); event.returnValue = ""; };
    window.addEventListener("beforeunload", leave);
    return () => window.removeEventListener("beforeunload", leave);
  }, [dirty]);

  function change<K extends keyof typeof values>(key: K, value: typeof values[K]) {
    setValues(current => ({ ...current, [key]: value }));
    setDirty(true); setPreview(false);
    setErrors(current => ({ ...current, [key]: "" }));
  }

  function requestClose() {
    if (saving.current) return;
    if (dirty) setDiscard(true); else onClose();
  }

  function validate() {
    const next: Record<string, string> = {};
    if (!values.title.trim() || values.title.trim().length > 120) next.title = "请填写网站名称，最多 120 字符。";
    if (!isWebsiteUrl(values.url.trim())) next.url = "请输入完整的 HTTPS 网站地址。";
    if (values.preview_enabled && values.preview_url.trim() && !isWebsiteUrl(values.preview_url.trim())) next.preview_url = "请输入完整的 HTTPS 预览地址，或留空。";
    if (values.description.trim().length > 300) next.description = "简介最多 300 字符。";
    if (!Number.isSafeInteger(values.sort_order) || Math.abs(values.sort_order) > 1_000_000) next.sort_order = "请输入 -1000000 至 1000000 之间的整数。";
    setErrors(next);
    const first = Object.keys(next)[0];
    if (first) requestAnimationFrame(() => formRef.current?.querySelector<HTMLElement>(`[name="${first}"]`)?.focus());
    return !first;
  }

  async function submit(event: FormEvent<HTMLFormElement>) {
    event.preventDefault();
    if (saving.current || !validate()) return;
    if (!session.author) { setLogin(true); return; }
    const submitter = (event.nativeEvent as SubmitEvent).submitter;
    const published = submitter instanceof HTMLButtonElement && submitter.value === "publish";
    saving.current = true; setBusy(true); setError(""); setPreview(false);
    const body = new FormData();
    Object.entries(values).forEach(([key, value]) => body.set(key, String(value).trim()));
    // An unfinished URL in a now-disabled section must not block saving.
    // Keep a previously valid preview URL so enabling it again needs no re-entry.
    body.set("preview_url", isWebsiteUrl(values.preview_url.trim()) ? values.preview_url.trim() : "");
    body.set("published", String(published));
    body.set("removeCover", String(removeCover));
    if (cover) body.set("cover", cover);
    try {
      const saved = readSavedProject(await projectRequest(project ? `/${project.id}` : "", { method: project ? "PATCH" : "POST", body }));
      setDirty(false);
      onSaved(saved);
    } catch (cause) {
      setError(cause instanceof Error ? cause.message : "保存结果未确认，请先核对项目列表。");
    } finally { saving.current = false; setBusy(false); }
  }

  const sample: WebsiteProject = {
    ...values, id: project?.id || 1, title: values.title || "网站名称",
    url: isWebsiteUrl(values.url) ? values.url : "https://example.com/",
    preview_url: isWebsiteUrl(values.preview_url) ? values.preview_url : null,
    cover_image: removeCover ? null : project?.cover_image || null, published: project?.published || false,
  };
  const previewValid = isWebsiteUrl(values.url) && (!values.preview_enabled || !values.preview_url || isWebsiteUrl(values.preview_url));

  return <>
    <SiteDialog title={project ? "编辑网站" : "添加网站"} onRequestClose={requestClose} wide className={styles.editor}>
      <form ref={formRef} className={styles.editorForm} noValidate onSubmit={submit}>
        <div className={styles.editorColumns}>
          <div className={styles.fields}>
            <p className={styles.note}>将独立网站展示到实验室。网址仅用于打开和预览，不显示在公开卡片中。</p>
            {!session.author ? <div className={styles.authNotice}>
              <p>请作为作者登录后保存。填写的内容会保留。</p>
              <button type="button" onClick={() => setLogin(true)}>作者登录</button>
            </div> : <p className={styles.note}>已作为作者登录</p>}
            <fieldset disabled={busy} className={styles.fieldset}>
              <label className="album-field"><span id="project-title-label">网站名称 *</span>
                <input name="title" aria-labelledby="project-title-label" value={values.title} maxLength={120} required onChange={e => change("title", e.target.value)}
                  aria-invalid={Boolean(errors.title)} aria-describedby={errors.title ? "project-title-error" : undefined} />
                {errors.title ? <small id="project-title-error" className={styles.error}>{errors.title}</small> : null}
              </label>
              <label className="album-field"><span id="project-url-label">网站地址 *</span>
                <input name="url" aria-labelledby="project-url-label" type="url" value={values.url} maxLength={2048} required placeholder="https://" onChange={e => change("url", e.target.value)}
                  aria-invalid={Boolean(errors.url)} aria-describedby={errors.url ? "project-url-error" : undefined} />
                {errors.url ? <small id="project-url-error" className={styles.error}>{errors.url}</small> : null}
              </label>
              <label className="album-field"><span id="project-description-label">一句话介绍</span>
                <textarea name="description" aria-labelledby="project-description-label" rows={3} className={styles["resize-none"]} value={values.description} maxLength={300} onChange={e => change("description", e.target.value)}
                  aria-invalid={Boolean(errors.description)} aria-describedby={errors.description ? "project-description-error" : undefined} />
                {errors.description ? <small id="project-description-error" className={styles.error}>{errors.description}</small> : null}
              </label>
              <label className="album-field"><span id="project-cover-label">封面图片</span>
                <input type="file" aria-labelledby="project-cover-label" aria-describedby="project-cover-help" accept="image/png,image/jpeg,image/webp,image/gif,image/avif" onChange={e => {
                  const file = e.target.files?.[0] || null;
                  if (file && file.size > 12 * 1024 * 1024) { setError("封面不能超过 12 MiB。"); e.target.value = ""; return; }
                  setCover(file); setRemoveCover(false); setDirty(true); setError("");
                }} />
                <small id="project-cover-help">JPEG、PNG、WebP、GIF 或 AVIF，最多 12 MiB。预览未加载时显示。</small>
              </label>
              {(cover || project?.cover_image) && !removeCover ? <button className={styles.textButton} type="button" onClick={() => {
                setCover(null); setRemoveCover(true); setDirty(true);
                const input = formRef.current?.querySelector<HTMLInputElement>('input[type="file"]');
                if (input) input.value = "";
              }}>移除封面</button> : null}
              <label className={styles.check}><input type="checkbox" checked={values.preview_enabled} onChange={e => change("preview_enabled", e.target.checked)} />启用卡片实时预览</label>
              {values.preview_enabled ? <label className="album-field"><span id="project-preview-label">预览地址</span>
                <input name="preview_url" aria-labelledby="project-preview-label" type="url" value={values.preview_url} maxLength={2048} placeholder="留空则使用网站地址" onChange={e => change("preview_url", e.target.value)}
                  aria-invalid={Boolean(errors.preview_url)} aria-describedby={errors.preview_url ? "project-preview-error" : "project-preview-help"} />
                <small id="project-preview-help">目标网站需要允许嵌入。卡片中的网页仅展示，不接收操作。</small>
                {errors.preview_url ? <small id="project-preview-error" className={styles.error}>{errors.preview_url}</small> : null}
              </label> : null}
              <div className={styles.fieldRow}>
                <label className="album-field"><span id="project-mode-label">打开方式</span>
                  <select aria-labelledby="project-mode-label" value={values.open_mode} onChange={e => change("open_mode", e.target.value === "external" ? "external" : "iframe")}>
                    <option value="iframe">博客内全屏查看</option><option value="external">新标签页独立打开</option>
                  </select>
                </label>
                <label className="album-field"><span id="project-order-label">排序（较小靠前）</span>
                  <input name="sort_order" aria-labelledby="project-order-label" type="number" min={-1000000} max={1000000} step={1} value={Number.isNaN(values.sort_order) ? "" : values.sort_order}
                    onChange={e => change("sort_order", e.target.valueAsNumber)} aria-invalid={Boolean(errors.sort_order)} aria-describedby={errors.sort_order ? "project-order-error" : undefined} />
                  {errors.sort_order ? <small id="project-order-error" className={styles.error}>{errors.sort_order}</small> : null}
                </label>
              </div>
            </fieldset>
          </div>
          <aside className={styles.editorPreview} aria-label="卡片效果">
            <p className={styles.note}>卡片效果</p>
            <div className={styles.card}>
              <ProjectPreview project={sample} active={preview && !viewer && !discard && !login} coverOverride={coverUrl} />
              <div className={styles.cardCopy}><h3>{sample.title}</h3><p>{sample.description || "在这里写一句作品介绍。"}</p></div>
            </div>
            <div className={styles.testActions}>
              <button type="button" disabled={!previewValid || !values.preview_enabled || busy} aria-pressed={preview} onClick={() => setPreview(value => !value)}>{preview ? "停止预览" : "测试卡片预览"}</button>
              <button type="button" disabled={!previewValid || busy} onClick={() => { setPreview(false); setViewer(true); }}>测试全屏查看</button>
            </div>
            <p className={styles.note}>请实际确认画面可见。部分网站会限制嵌入；此时可以关闭实时预览，选择独立打开。</p>
          </aside>
        </div>
        {error ? <p className={styles.error} role="alert">{error}</p> : null}
        <footer className={styles.formFooter}>
          <button type="button" disabled={busy} onClick={requestClose}>取消</button>
          <span />
          {!project?.published ? <button type="submit" value="draft" disabled={busy || !session.author}>保存草稿</button> : null}
          <button className={styles.primary} type="submit" value="publish" disabled={busy || !session.author} aria-busy={busy}>{busy ? "正在保存…" : project?.published ? "保存更改" : "发布到实验室"}</button>
        </footer>
      </form>
    </SiteDialog>
    {login ? <AuthorSignIn onClose={() => setLogin(false)} /> : null}
    {viewer ? <ProjectViewer project={sample} onClose={() => setViewer(false)} /> : null}
    {discard ? <SiteDialog title="放弃未保存的更改？" onRequestClose={() => setDiscard(false)}>
      <p className={styles.note}>关闭后，本次填写的内容不会保存。</p>
      <div className={styles.testActions}><button type="button" onClick={() => setDiscard(false)}>继续编辑</button><button type="button" onClick={onClose}>放弃更改</button></div>
    </SiteDialog> : null}
  </>;
}
