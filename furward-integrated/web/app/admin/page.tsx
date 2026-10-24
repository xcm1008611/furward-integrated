import { cookies } from "next/headers";
import { redirect } from "next/navigation";
import { ADMIN_COOKIE, validateAdminSession } from "@/lib/admin-auth";
import AdminClient from "./AdminClient";
import "./admin.css";

export const dynamic = "force-dynamic";
export const metadata = { title: "内容管理 · FURWARD", robots: { index: false, follow: false } };

export default async function AdminPage() {
  if (!(await validateAdminSession((await cookies()).get(ADMIN_COOKIE)?.value))) redirect("/admin/login");
  return <AdminClient />;
}
