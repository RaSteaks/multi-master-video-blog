"use client";

import { useEffect, useId, useRef, useState, type FormEvent } from "react";
import { signIn } from "@/lib/author-session";

export function AuthorSignIn({ onClose }: { onClose: () => void }) {
  const dialog = useRef<HTMLDialogElement>(null);
  const input = useRef<HTMLInputElement>(null);
  const id = useId();
  const [token, setToken] = useState("");
  const [visible, setVisible] = useState(false);
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState("");
  useEffect(() => {
    const target = document.activeElement;
    const fallback = document.querySelector<HTMLElement>(".create-menu .action-menu-trigger");
    dialog.current?.showModal();
    input.current?.focus();
    return () => { (target instanceof HTMLElement && target.isConnected ? target : fallback)?.focus(); };
  }, []);

  async function submit(event: FormEvent<HTMLFormElement>) {
    event.preventDefault();
    if (busy) return;
    if (!token || token.length > 512) { setError("请输入有效的上传令牌（最多 512 个字符）。"); input.current?.focus(); return; }
    setBusy(true);
    setError("");
    const submitted = token;
    setToken("");
    // Clear the DOM too before yielding; credentials live only in this request.
    if (input.current) input.current.value = "";
    try { await signIn(submitted); onClose(); }
    catch (cause) { setError(cause instanceof Error ? cause.message : "登录失败，请重试。"); input.current?.focus(); }
    finally { setBusy(false); }
  }

  return (
    <dialog ref={dialog} className="album-dialog author-sign-in" aria-labelledby={`${id}-title`} onClose={onClose}>
      <div className="album-dialog-surface">
        <header className="album-dialog-header">
          <h2 id={`${id}-title`}>作者登录</h2>
          <button type="button" className="album-icon-button" aria-label="关闭登录框" onClick={onClose}>×</button>
        </header>
        <form noValidate onSubmit={submit} className="album-form">
          <label className="album-field" htmlFor={`${id}-token`}>
            <span>上传令牌</span>
            <input ref={input} id={`${id}-token`} name="password" type={visible ? "text" : "password"}
              autoComplete="current-password" spellCheck={false} value={token} maxLength={512}
              onChange={event => setToken(event.target.value)} aria-invalid={Boolean(error)}
              aria-describedby={`${id}-help ${id}-error`} />
          </label>
          <button type="button" className="album-action-button" aria-pressed={visible} onClick={() => setVisible(!visible)}>
            {visible ? "隐藏令牌" : "显示令牌"}
          </button>
          <p id={`${id}-help`} className="album-inline-note">登录有效期为 6 小时。令牌仅用于本次验证，不会写入本站的浏览器存储。</p>
          <p id={`${id}-error`} className="author-sign-in-error" role="status">{error}</p>
          <button type="submit" className="album-action-button album-submit" disabled={busy} aria-busy={busy}>{busy ? "正在登录…" : "登录"}</button>
        </form>
      </div>
    </dialog>
  );
}
