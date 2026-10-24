import { isAdminAuthenticated } from "@/lib/admin-auth";
import { CmsConflictError, getContent, saveContent } from "@/lib/cms-store";
import { CmsValidationError, isSameOrigin, readLimitedBody, validateSavePayload } from "@/lib/cms-validation";

export const dynamic = "force-dynamic";
const headers = { "Cache-Control": "no-store", "X-Content-Type-Options": "nosniff" };

export async function GET() {
  try { return Response.json(await getContent(), { headers }); }
  catch (error) {
    console.error("CMS content read failed", error);
    return Response.json({ error: "暂时无法读取网站内容，请稍后刷新。" }, { status: 503, headers });
  }
}

export async function PUT(request: Request) {
  if (!isSameOrigin(request)) return Response.json({ error: "请在本站后台保存内容。" }, { status: 403, headers });
  if (!(await isAdminAuthenticated(request))) return Response.json({ error: "登录已过期，请重新登录后台后保存。当前草稿仍保留在浏览器中。" }, { status: 401, headers });
  try {
    const bytes = await readLimitedBody(request, 256 * 1024);
    let payload: unknown;
    try { payload = JSON.parse(new TextDecoder().decode(bytes)); }
    catch { throw new CmsValidationError("保存内容格式不正确，请刷新后台重试。"); }
    const { content, expectedRevision } = validateSavePayload(payload);
    return Response.json(await saveContent(content, expectedRevision), { headers });
  } catch (error) {
    if (error instanceof CmsValidationError) return Response.json({ error: error.message }, { status: 400, headers });
    if (error instanceof CmsConflictError) return Response.json({ error: error.message }, { status: 409, headers });
    console.error("CMS content save failed", error);
    return Response.json({ error: "内容未保存成功，请保留当前页面，稍后重试。" }, { status: 503, headers });
  }
}
