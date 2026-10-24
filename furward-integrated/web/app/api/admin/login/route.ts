import { adminCookie, createAdminSession, isAdminConfigured, loginRateLimitKey, verifyAdminPassword } from "@/lib/admin-auth";
import { checkLoginRateLimit, clearLoginFailures, recordLoginFailure } from "@/lib/cms-store";
import { isSameOrigin, readLimitedBody } from "@/lib/cms-validation";

export const dynamic = "force-dynamic";
const headers = { "Cache-Control": "no-store", "X-Content-Type-Options": "nosniff" };

export async function POST(request: Request) {
  if (!isSameOrigin(request)) return Response.json({ error: "请在本站登录页面操作。" }, { status: 403, headers });
  if (!isAdminConfigured()) return Response.json({ error: "管理员尚未完成登录配置，请联系网站负责人。" }, { status: 503, headers });
  try {
    const key = await loginRateLimitKey(request);
    // Reserve before deriving the password hash so concurrent attempts cannot
    // pass a read-only limit check together.
    const rate = await checkLoginRateLimit(key);
    if (!rate.allowed) return Response.json({ error: "尝试次数过多，请 15 分钟后再试。" }, { status: 429, headers: { ...headers, "Retry-After": String(rate.retryAfter) } });
    let password = "";
    try {
      if (!request.headers.get("content-type")?.toLowerCase().startsWith("application/json")) throw new Error("Invalid request");
      const payload = JSON.parse(new TextDecoder().decode(await readLimitedBody(request, 8192))) as Record<string, unknown>;
      if (typeof payload.password === "string" && payload.password.length <= 1024) password = payload.password;
    } catch { /* Invalid and incorrect credentials have the same response. */ }
    if (!password || !(await verifyAdminPassword(password))) {
      await recordLoginFailure(key);
      return Response.json({ error: "密码不正确，请检查后重试。" }, { status: 401, headers });
    }
    await clearLoginFailures(key);
    return Response.json({ ok: true, next: "/admin" }, { headers: { ...headers, "Set-Cookie": adminCookie(request, await createAdminSession()) } });
  } catch {
    // Never log request bodies, hashes, session cookies or configured secrets.
    return Response.json({ error: "暂时无法登录，请稍后再试。" }, { status: 503, headers });
  }
}
