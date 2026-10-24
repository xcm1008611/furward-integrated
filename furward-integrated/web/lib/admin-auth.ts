import { getAdminConfig, getLoginAddress } from "@/lib/admin-config";
import { getRequestProtocol } from "@/lib/cms-validation";

export const ADMIN_COOKIE = "lando_admin_session";
export const ADMIN_SESSION_SECONDS = 8 * 60 * 60;
const encoder = new TextEncoder();

function encode(bytes: Uint8Array): string {
  let text = "";
  for (const byte of bytes) text += String.fromCharCode(byte);
  return btoa(text).replace(/\+/g, "-").replace(/\//g, "_").replace(/=+$/, "");
}
function decode(value: string): Uint8Array<ArrayBuffer> {
  if (!/^[A-Za-z0-9_-]+$/.test(value)) throw new Error("Invalid encoded value");
  const text = atob(value.replace(/-/g, "+").replace(/_/g, "/"));
  const bytes = Uint8Array.from(text, (character) => character.charCodeAt(0));
  if (encode(bytes) !== value) throw new Error("Invalid encoded value");
  return bytes;
}
function parseHash(value: string) {
  const parts = value.split(value.includes(":") ? ":" : "$");
  if (parts.length !== 4 || parts[0] !== "pbkdf2-sha256" || !/^\d{6}$/.test(parts[1])) throw new Error("Invalid admin configuration");
  const iterations = Number(parts[1]);
  const salt = decode(parts[2]);
  const hash = decode(parts[3]);
  if (iterations < 100000 || iterations > 600000 || salt.length < 16 || salt.length > 64 || hash.length !== 32) throw new Error("Invalid admin configuration");
  return { iterations, salt, hash };
}
export function isAdminConfigured(): boolean {
  try {
    const config = getAdminConfig();
    parseHash(config.passwordHash);
    return encoder.encode(config.sessionSecret).length >= 32;
  } catch { return false; }
}
async function signingKey() {
  const config = getAdminConfig();
  if (!isAdminConfigured()) throw new Error("Admin authentication is unavailable");
  // Rotating either the password or session secret invalidates all old cookies.
  return crypto.subtle.importKey("raw", encoder.encode(`${config.sessionSecret}\0${config.passwordHash}`), { name: "HMAC", hash: "SHA-256" }, false, ["sign", "verify"]);
}
export async function verifyAdminPassword(password: string): Promise<boolean> {
  if (!isAdminConfigured() || typeof password !== "string" || password.length > 1024) return false;
  const { iterations, salt, hash } = parseHash(getAdminConfig().passwordHash);
  const key = await crypto.subtle.importKey("raw", encoder.encode(password), "PBKDF2", false, ["deriveBits"]);
  const actual = new Uint8Array(await crypto.subtle.deriveBits({ name: "PBKDF2", hash: "SHA-256", salt, iterations }, key, 256));
  let difference = 0;
  for (let i = 0; i < hash.length; i++) difference |= actual[i] ^ hash[i];
  return difference === 0;
}
export async function createAdminSession(now = Date.now()): Promise<string> {
  const issuedAt = Math.floor(now / 1000);
  const payload = encode(encoder.encode(JSON.stringify({ v: 1, iat: issuedAt, exp: issuedAt + ADMIN_SESSION_SECONDS, nonce: crypto.randomUUID() })));
  const signature = new Uint8Array(await crypto.subtle.sign("HMAC", await signingKey(), encoder.encode(payload)));
  return `${payload}.${encode(signature)}`;
}
export async function validateAdminSession(token: string | undefined, now = Date.now()): Promise<boolean> {
  if (!token || token.length > 1024 || !isAdminConfigured()) return false;
  try {
    const parts = token.split(".");
    if (parts.length !== 2) return false;
    const verified = await crypto.subtle.verify("HMAC", await signingKey(), decode(parts[1]), encoder.encode(parts[0]));
    if (!verified) return false;
    const payload = JSON.parse(new TextDecoder().decode(decode(parts[0]))) as Record<string, unknown>;
    const current = Math.floor(now / 1000);
    return payload.v === 1 && Number.isInteger(payload.iat) && Number.isInteger(payload.exp)
      && typeof payload.iat === "number" && typeof payload.exp === "number"
      && payload.iat <= current + 30 && payload.exp > current
      && payload.exp - payload.iat === ADMIN_SESSION_SECONDS;
  } catch { return false; }
}
export async function isAdminAuthenticated(request: Request): Promise<boolean> {
  const values = (request.headers.get("cookie") ?? "").split(";").map((entry) => entry.trim()).filter((entry) => entry.startsWith(`${ADMIN_COOKIE}=`));
  return values.length === 1 && validateAdminSession(values[0].slice(ADMIN_COOKIE.length + 1));
}
export function adminCookie(request: Request, token: string, maxAge = ADMIN_SESSION_SECONDS): string {
  return `${ADMIN_COOKIE}=${token}; Path=/; HttpOnly; SameSite=Strict; Max-Age=${maxAge}${getRequestProtocol(request) === "https:" ? "; Secure" : ""}`;
}
export async function loginRateLimitKey(request: Request): Promise<string> {
  // Cloudflare supplies this trusted header. Self-hosting without a trusted
  // upstream shares a single bucket rather than trusting spoofable forwarded IPs.
  const address = getLoginAddress(request);
  const digest = await crypto.subtle.sign("HMAC", await signingKey(), encoder.encode(`login-rate:${address}`));
  return encode(new Uint8Array(digest));
}
