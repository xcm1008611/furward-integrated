// The self-hosted Next build aliases @/lib/admin-config to this module.
export function getLoginAddress(_request: Request): string {
  // A single administrator needs no client-supplied IP headers. A shared bucket
  // remains effective when the service is reached directly or through a proxy.
  return "shared-admin-login";
}
export function getAdminConfig(): { passwordHash: string; sessionSecret: string } {
  return { passwordHash: process.env.ADMIN_PASSWORD_HASH ?? "", sessionSecret: process.env.ADMIN_SESSION_SECRET ?? "" };
}
