import { supabase } from "@/integrations/supabase/client";

const KEY = "busmap.visitor.v1";
const COOKIE = "busmap_visitor";
export type VisitorCreds = { visitor_id: string; secret: string };

function validCreds(v: unknown): v is VisitorCreds {
  const o = v as Partial<VisitorCreds> | null;
  return !!o && typeof o.visitor_id === "string" && o.visitor_id !== "" && typeof o.secret === "string" && o.secret.length === 64;
}

// Alguns WebViews (App Inventor) não guardam localStorage entre aberturas do app: usa cookie como reserva.
function readCookie(): VisitorCreds | null {
  try {
    if (typeof document === "undefined") return null;
    const m = document.cookie.match(new RegExp(`(?:^|; )${COOKIE}=([^;]*)`));
    if (!m) return null;
    const v = JSON.parse(decodeURIComponent(m[1] ?? "")) as unknown;
    return validCreds(v) ? v : null;
  } catch {
    return null;
  }
}

function writeCookie(c: VisitorCreds): void {
  try {
    if (typeof document === "undefined") return;
    const secure = typeof location !== "undefined" && location.protocol === "https:" ? "; Secure" : "";
    document.cookie = `${COOKIE}=${encodeURIComponent(JSON.stringify(c))}; max-age=31536000; path=/; SameSite=Lax${secure}`;
  } catch {
    // ignora
  }
}

/** Guarda a identidade do aparelho no armazenamento local e em cookie (reserva). */
export function saveVisitor(c: VisitorCreds): void {
  try {
    if (typeof localStorage !== "undefined") localStorage.setItem(KEY, JSON.stringify(c));
  } catch {
    // Keep credentials in memory for this page even if persistence is unavailable.
  }
  writeCookie(c);
}

/** Random device identity issued by the backend; the secret is the only proof of ownership. */
export async function ensureVisitor(): Promise<VisitorCreds> {
  const existing = readVisitor();
  if (existing) return existing;
  const { data, error } = await supabase.rpc("register_visitor");
  if (error) throw error;
  const creds = data as unknown as VisitorCreds;
  saveVisitor(creds);
  return creds;
}

export function readVisitor(): VisitorCreds | null {
  try {
    if (typeof localStorage !== "undefined") {
      const raw = localStorage.getItem(KEY);
      if (raw) {
        const v = JSON.parse(raw) as unknown;
        if (validCreds(v)) return v;
      }
    }
  } catch {
    // cai para o cookie
  }
  return readCookie();
}
