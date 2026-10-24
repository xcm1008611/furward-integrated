import { adminCookie } from "@/lib/admin-auth";
import { isSameOrigin } from "@/lib/cms-validation";

export const dynamic = "force-dynamic";
export async function POST(request: Request) {
  const headers = { "Cache-Control": "no-store", "X-Content-Type-Options": "nosniff" };
  if (!isSameOrigin(request)) return Response.json({ error: "请在本站后台退出登录。" }, { status: 403, headers });
  return Response.json({ ok: true }, { headers: { ...headers, "Set-Cookie": adminCookie(request, "", 0) } });
}
