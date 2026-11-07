"use client";

import { useRef, useState } from "react";
import { PROJECT_LAYOUTS, type ProjectLayout } from "../../../../shared/project-layouts.cjs";
import { projectRequest, readSavedLayout } from "@/lib/external-projects";
import styles from "./ProjectLayouts.module.css";

export function ProjectLayoutSettings({ layout, saved, unavailable, onChange, onSaved }: {
  layout: ProjectLayout; saved: ProjectLayout; unavailable: boolean;
  onChange: (layout: ProjectLayout) => void; onSaved: (layout: ProjectLayout) => void;
}) {
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState("");
  const saving = useRef(false);
  const dirty = layout !== saved;

  async function save() {
    if (saving.current) return;
    saving.current = true; setBusy(true); setError("");
    try {
      onSaved(readSavedLayout(await projectRequest("/layout", { method: "PATCH", body: JSON.stringify({ layout }) })));
    } catch (cause) {
      setError(cause instanceof Error ? cause.message : "布局保存失败，请重试。");
    } finally { saving.current = false; setBusy(false); }
  }

  return <section className={styles.settings} aria-label="展示布局">
    <fieldset disabled={busy}>
      <legend>展示布局</legend>
      <p>选择后可在下方预览，保存后统一应用于访客页面。</p>
      <div className={styles.choices}>
        {PROJECT_LAYOUTS.map(option => <label key={option.value} className={styles.choice}>
          <input type="radio" name="project-layout" value={option.value} checked={layout === option.value}
            onChange={() => { onChange(option.value); setError(""); }} />
          <span><strong>{option.label}</strong><small>{option.description}</small></span>
        </label>)}
      </div>
    </fieldset>
    {unavailable ? <p role="status">暂未读取到已保存的布局，当前展示双列。请确认 CMS 已安装实验室布局字段后重试。</p> : null}
    <div className={styles.settingsActions}>
      <p role="status">{dirty ? "正在预览，尚未保存。" : "当前使用已保存的布局。"}</p>
      <button type="button" disabled={busy || !dirty} onClick={() => { onChange(saved); setError(""); }}>取消预览</button>
      <button type="button" disabled={busy || (!dirty && !unavailable)} aria-busy={busy} onClick={() => void save()}>{busy ? "正在保存…" : "保存布局"}</button>
    </div>
    {error ? <p className={styles.error} role="alert">{error}</p> : null}
  </section>;
}
