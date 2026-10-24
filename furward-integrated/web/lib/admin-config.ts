import { env } from "cloudflare:workers";

export function getLoginAddress(request: Request): string {
  return request.headers.get("cf-connecting-ip")?.slice(0, 64) || "shared-admin-login";
}

export function getAdminConfig(): { passwordHash: string; sessionSecret: string } {
  const bindings = env as unknown as Record<string, unknown>;
  return {
    passwordHash: typeof bindings.ADMIN_PASSWORD_HASH === "string" ? bindings.ADMIN_PASSWORD_HASH : "",
    sessionSecret: typeof bindings.ADMIN_SESSION_SECRET === "string" ? bindings.ADMIN_SESSION_SECRET : "",
  };
}
