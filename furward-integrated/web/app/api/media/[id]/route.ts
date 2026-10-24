import { getMedia } from "@/lib/cms-store";
import { MEDIA_ID_PATTERN } from "@/lib/cms-validation";

export const dynamic = "force-dynamic";
const mediaTypes: Record<string, string> = { jpg: "image/jpeg", png: "image/png", webp: "image/webp", gif: "image/gif" };

export async function GET(request: Request, context: { params: Promise<{ id: string }> }) {
  const { id } = await context.params;
  if (!MEDIA_ID_PATTERN.test(id)) return new Response("图片不存在", { status: 404 });
  try {
    const object = await getMedia(id);
    if (!object) return new Response("图片不存在", { status: 404 });
    const headers = new Headers({
      "Content-Type": mediaTypes[id.split(".").pop()!],
      "X-Content-Type-Options": "nosniff",
      "Content-Disposition": `inline; filename="${id}"`,
      "Cache-Control": "public, max-age=31536000, immutable",
      "ETag": object.httpEtag,
    });
    if (request.headers.get("if-none-match") === object.httpEtag) return new Response(null, { status: 304, headers });
    headers.set("Content-Length", String(object.size));
    return new Response(object.body, { headers });
  } catch (error) {
    console.error("CMS media read failed", error);
    return new Response("图片暂时无法读取", { status: 503, headers: { "Cache-Control": "no-store" } });
  }
}
