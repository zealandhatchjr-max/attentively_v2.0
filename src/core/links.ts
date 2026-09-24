import { createHmac, timingSafeEqual } from "node:crypto";

/**
 * Signed, expiring links for emails and pages (approve a plan, view the board,
 * answer a Needs-you question, press Resolved). No login needed to use them, so
 * they're scoped to one run and one purpose.
 */
export type LinkPurpose = "approve" | "board";

export interface LinkClaims {
  run: string;
  user: string;
  purpose: LinkPurpose;
  plan?: number;
  exp: number; // unix seconds
}

export function signLink(secret: string, claims: Omit<LinkClaims, "exp">, ttlSeconds: number): string {
  const body = Buffer.from(
    JSON.stringify({ ...claims, exp: Math.floor(Date.now() / 1000) + ttlSeconds }),
  ).toString("base64url");
  const sig = createHmac("sha256", secret).update(body).digest("base64url");
  return `${body}.${sig}`;
}

export function verifyLink(secret: string, token: string, purpose: LinkPurpose): LinkClaims | null {
  const [body, sig] = token.split(".");
  if (!body || !sig) return null;
  const expected = createHmac("sha256", secret).update(body).digest();
  const given = Buffer.from(sig, "base64url");
  if (given.length !== expected.length || !timingSafeEqual(given, expected)) return null;
  try {
    const claims = JSON.parse(Buffer.from(body, "base64url").toString()) as LinkClaims;
    if (claims.purpose !== purpose || claims.exp < Date.now() / 1000) return null;
    return claims;
  } catch {
    return null;
  }
}
