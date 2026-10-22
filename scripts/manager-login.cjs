function loginHtml({ basePath, nonce, styles }) {
  // All visual tokens and form controls come from the Manager's shared styles.
  // No credential is embedded in HTML or persisted by the login script.
  return String.raw`<!doctype html>
<html lang="zh-CN">
<head>
  <meta charset="utf-8" />
  <meta name="viewport" content="width=device-width, initial-scale=1" />
  <meta name="color-scheme" content="light dark" />
  <title>登录 · Service Manager</title>
  <style>${styles}
    .login-app { min-height: 100svh; display: grid; place-items: center; padding: 32px 20px; }
    .login-shell { width: min(420px, 100%); min-width: 0; }
    .login-brand { margin-bottom: 28px; }
    .login-brand h1 { margin-top: 8px; }
    .login-card { padding: 28px; border: 1px solid var(--line); border-radius: var(--radius); background: var(--surface); box-shadow: var(--shadow); }
    .login-card h2 { font-size: 20px; margin-bottom: 6px; }
    .login-copy, .login-footer { color: var(--muted); font-size: 13px; }
    .login-form { display: grid; gap: 20px; margin-top: 26px; }
    .login-field { display: grid; gap: 8px; }
    .login-field label { font-size: 13px; font-weight: 600; }
    .login-field .cred-input { width: 100%; min-height: 44px; font: inherit; }
    .login-password { display: flex; gap: 8px; align-items: center; }
    .login-password input { min-width: 0; }
    .login-password .button { min-width: 56px; min-height: 44px; }
    .login-submit { width: 100%; min-height: 44px; }
    .login-message { min-height: 40px; color: var(--bad); font-size: 13px; overflow-wrap: anywhere; }
    .login-footer { display: flex; flex-wrap: wrap; gap: 8px 16px; margin-top: 22px; justify-content: center; }
    .login-footer span::before { content: ""; display: inline-block; width: 5px; height: 5px; border: 1px solid var(--muted); border-radius: 50%; margin: 0 6px 2px 0; }
    @media (max-width: 420px) { .login-card { padding: 24px 20px; } }
  </style>
</head>
<body>
  <main class="login-app">
    <div class="login-shell">
      <header class="login-brand"><p class="eyebrow">MMVB · Local stack</p><h1>Service Manager</h1></header>
      <section class="login-card" aria-labelledby="loginTitle">
        <h2 id="loginTitle">登录管理控制台</h2>
        <p class="login-copy">查看服务状态、执行操作和跟踪当前任务。</p>
        <form id="loginForm" class="login-form" method="post" novalidate>
          <div class="login-field">
            <label for="username">账号</label>
            <input class="cred-input" id="username" name="username" type="text" autocomplete="username" autocapitalize="none" spellcheck="false" required aria-describedby="loginMessage" />
          </div>
          <div class="login-field">
            <label for="password">密码</label>
            <div class="login-password">
              <input class="cred-input" id="password" name="password" type="password" autocomplete="current-password" required aria-describedby="loginMessage" />
              <button class="button" id="showPassword" type="button" aria-label="显示密码" aria-pressed="false">显示</button>
            </div>
          </div>
          <button class="button primary login-submit" id="loginButton" type="submit">登录</button>
          <p id="loginMessage" class="login-message" role="status" aria-live="polite" aria-atomic="true"></p>
        </form>
        <noscript><p class="login-message">请启用 JavaScript 后登录管理控制台。</p></noscript>
      </section>
      <footer class="login-footer" aria-label="管理服务"><span>PostgreSQL</span><span>CMS</span><span>API</span><span>Web</span></footer>
    </div>
  </main>
  <script>
    const BASE = ${JSON.stringify(basePath)};
    const LOGIN_NONCE = ${JSON.stringify(nonce)};
    const form = document.getElementById("loginForm");
    const username = document.getElementById("username");
    const password = document.getElementById("password");
    const button = document.getElementById("loginButton");
    const message = document.getElementById("loginMessage");
    const showPassword = document.getElementById("showPassword");
    let pending = false;
    showPassword.addEventListener("click", () => {
      const reveal = password.type === "password";
      password.type = reveal ? "text" : "password";
      showPassword.textContent = reveal ? "隐藏" : "显示";
      showPassword.setAttribute("aria-label", reveal ? "隐藏密码" : "显示密码");
      showPassword.setAttribute("aria-pressed", String(reveal));
    });
    form.addEventListener("input", event => event.target.removeAttribute("aria-invalid"));
    form.addEventListener("submit", async event => {
      event.preventDefault();
      if (pending) return;
      message.textContent = "";
      for (const input of [username, password]) input.removeAttribute("aria-invalid");
      const missing = !username.value ? username : !password.value ? password : null;
      if (missing) {
        missing.setAttribute("aria-invalid", "true");
        message.textContent = missing === username ? "请输入账号。" : "请输入密码。";
        missing.focus();
        return;
      }
      pending = true;
      button.disabled = true;
      form.setAttribute("aria-busy", "true");
      button.textContent = "正在登录…";
      try {
        const response = await fetch(BASE + "/api/login", {
          method: "POST", credentials: "same-origin", signal: AbortSignal.timeout(15000),
          headers: { "Content-Type": "application/json", "X-Manager-CSRF": LOGIN_NONCE },
          body: JSON.stringify({ username: username.value, password: password.value })
        });
        const data = await response.json();
        if (!response.ok) {
          if (response.status === 401) { password.value = ""; password.setAttribute("aria-invalid", "true"); password.focus(); }
          throw new Error(response.status === 403 ? "登录页面已过期，请刷新后重试。" : data.error || "登录失败，请重试。");
        }
        password.value = "";
        location.replace(BASE || "/");
      } catch (error) {
        message.textContent = error.name === "TimeoutError" || error.name === "TypeError"
          ? "暂时无法连接 Manager，请检查连接后重试。" : error.message;
      } finally {
        pending = false;
        button.disabled = false;
        button.textContent = "登录";
        form.setAttribute("aria-busy", "false");
      }
    });
  </script>
</body>
</html>`;
}

module.exports = { loginHtml };
