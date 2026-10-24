import Link from "next/link";
import { cookies } from "next/headers";
import { redirect } from "next/navigation";
import { ADMIN_COOKIE, isAdminConfigured, validateAdminSession } from "@/lib/admin-auth";
import LoginForm from "./LoginForm";
import "../admin.css";
import "./login.css";

export const dynamic = "force-dynamic";
export const metadata = { title: "后台登录 · FURWARD", robots: { index: false, follow: false } };

export default async function AdminLoginPage() {
  if (await validateAdminSession((await cookies()).get(ADMIN_COOKIE)?.value)) redirect("/admin");
  return <main className="admin-shell admin-login-shell" data-ui>
    <Link className="admin-brand" href="/" aria-label="返回网站首页"><span className="admin-brand-mark" aria-hidden="true">F</span><span>FURWARD<span className="admin-brand-sub">内容管理</span></span></Link>
    <section className="admin-login-card" aria-labelledby="login-heading">
      <span className="admin-login-label">网站内容管理</span>
      <h1 id="login-heading">欢迎回来</h1>
      <p>输入你的后台密码，就可以替换图片、修改文字和更新网站。</p>
      <LoginForm configured={isAdminConfigured()} />
      <Link className="admin-login-back" href="/">← 返回前台网站</Link>
    </section>
    <p className="admin-login-footnote">访客浏览网站无需登录。这里仅供网站管理员使用。</p>
  </main>;
}
