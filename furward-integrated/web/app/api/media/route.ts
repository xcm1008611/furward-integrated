import { isAdminAuthenticated } from "@/lib/admin-auth";
import { listMedia, saveMedia } from "@/lib/cms-store";
import { CmsValidationError, MAX_IMAGE_BYTES, detectImage, isSameOrigin, readLimitedBody, safeDisplayName } from "@/lib/cms-validation";

export const dynamic = "force-dynamic";
const headers = { "Cache-Control": "no-store", "X-Content-Type-Options": "nosniff" };

export async function GET(request: Request) {
  if (!(await isAdminAuthenticated(request))) return Response.json({ error: "登录已过期，请重新登录后台后查看素材库。" }, { status: 401, headers });
  try { return Response.json({ items: await listMedia() }, { headers }); }
  catch (error) {
    console.error("CMS media list failed", error);
    return Response.json({ error: "素材库暂时无法读取，请稍后刷新。" }, { status: 503, headers });
  }
}

export async function POST(request: Request) {
  if (!isSameOrigin(request)) return Response.json({ error: "请在本站后台上传图片。" }, { status: 403, headers });
  if (!(await isAdminAuthenticated(request))) return Response.json({ error: "登录已过期，请重新登录后台后上传。当前草稿仍保留在浏览器中。" }, { status: 401, headers });
  try {
    const contentType = request.headers.get("content-type") ?? "";
    if (!contentType.toLowerCase().startsWith("multipart/form-data;")) throw new CmsValidationError("请通过后台的上传按钮选择图片。");
    const body = await readLimitedBody(request, MAX_IMAGE_BYTES + 1024 * 1024);
    let form: FormData;
    try { form = await new Response(body, { headers: { "Content-Type": contentType } }).formData(); }
    catch { throw new CmsValidationError("未能读取上传图片，请重新选择文件。"); }
    const files = form.getAll("file");
    if (files.length !== 1 || typeof files[0] === "string") throw new CmsValidationError("每次请选择一张图片上传。");
    const file = files[0];
    if (file.size > MAX_IMAGE_BYTES) throw new CmsValidationError("每张图片不能超过 10 MB，请压缩图片后重试。");
    const bytes = new Uint8Array(await file.arrayBuffer());
    const { type, extension } = detectImage(bytes, file.type);
    const item = await saveMedia(bytes, safeDisplayName(file.name), type, extension);
    return Response.json({ item }, { status: 201, headers });
  } catch (error) {
    if (error instanceof CmsValidationError) return Response.json({ error: error.message }, { status: 400, headers });
    console.error("CMS media upload failed", error);
    return Response.json({ error: "图片未上传成功，请稍后重新上传。" }, { status: 503, headers });
  }
}
