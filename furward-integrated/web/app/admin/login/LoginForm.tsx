"use client";

import { useState, type FormEvent } from "react";

export default function LoginForm({ configured }: { configured: boolean }) {
  const [password, setPassword] = useState("");
  const [visible, setVisible] = useState(false);
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState("");
  async function submit(event: FormEvent<HTMLFormElement>) {
    event.preventDefault();
    if (busy) return;
    setBusy(true); setError("");
    try {
      const response = await fetch("/api/admin/login", { method: "POST", headers: { "Content-Type": "application/json" }, body: JSON.stringify({ password }) });
      const result = await response.json() as { error?: string };
      if (!response.ok) { setError(result.error || "登录没有完成，请稍后重试。"); return; }
      window.location.replace("/admin");
    } catch { setError("暂时连接不上网站，请检查网络后重试。"); }
    finally { setBusy(false); }
  }
  if (!configured) return <div role="status" className="admin-login-unconfigured"><strong>管理员尚未完成登录配置</strong><p>请先按部署说明设置后台密码，完成后刷新此页。前台浏览不受影响。</p></div>;
  return <form className="admin-login-form" onSubmit={submit}>
    <label htmlFor="admin-password">后台密码</label>
    <div className="admin-login-password"><input id="admin-password" name="password" type={visible ? "text" : "password"} autoComplete="current-password" required maxLength={1024} value={password} onChange={event => setPassword(event.target.value)} aria-describedby="login-help login-error" autoFocus /><button type="button" onClick={() => setVisible(!visible)} aria-label={visible ? "隐藏密码" : "显示密码"} aria-pressed={visible}>{visible ? "隐藏" : "显示"}</button></div>
    <p id="login-help" className="admin-login-help">使用你设置的独立密码，无需 ChatGPT 账号。</p>
    <p id="login-error" role="alert" className="admin-login-error">{error}</p>
    <button className="admin-button admin-primary admin-login-submit" type="submit" disabled={busy || !password}>{busy ? "正在登录…" : "进入后台"}<span aria-hidden="true">↗</span></button>
    <p className="admin-login-help">忘记密码？请联系部署网站的人，按部署说明重新设置。</p>
  </form>;
}
