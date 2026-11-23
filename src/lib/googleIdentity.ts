/**
 * Entrar com Google via Google Identity Services (GIS) + supabase.auth.signInWithIdToken.
 * Fluxo: o Google devolve um ID token (credential) → o Supabase valida com o provedor Google configurado
 * (Client ID cadastrado) → cria a sessão. O nonce vai com hash SHA-256 para o Google e "cru" para o Supabase.
 */

export type GoogleCredentialResponse = { credential?: string; select_by?: string };

type GsiConfig = {
  client_id: string;
  callback: (r: GoogleCredentialResponse) => void;
  nonce?: string;
  ux_mode?: "popup" | "redirect";
  use_fedcm_for_prompt?: boolean;
  itp_support?: boolean;
  auto_select?: boolean;
  cancel_on_tap_outside?: boolean;
};

type GsiId = {
  initialize: (cfg: GsiConfig) => void;
  renderButton: (el: HTMLElement, opts: Record<string, unknown>) => void;
  cancel: () => void;
  disableAutoSelect: () => void;
};

declare global {
  interface Window {
    google?: { accounts?: { id?: GsiId } };
  }
}

export const GSI_SRC = "https://accounts.google.com/gsi/client";
let gsiPromise: Promise<void> | null = null;

export function getGsi(): GsiId | null {
  return typeof window !== "undefined" ? (window.google?.accounts?.id ?? null) : null;
}

/** Carrega o script do Google uma única vez. */
export function loadGoogleIdentity(timeoutMs = 10000): Promise<void> {
  if (typeof window === "undefined") return Promise.reject(new Error("sem janela"));
  if (getGsi()) return Promise.resolve();
  if (gsiPromise) return gsiPromise;
  gsiPromise = new Promise<void>((resolve, reject) => {
    const s = document.createElement("script");
    s.src = GSI_SRC;
    s.async = true;
    s.defer = true;
    const fail = (msg: string) => {
      clearTimeout(t);
      gsiPromise = null;
      s.remove();
      reject(new Error(msg));
    };
    const t = setTimeout(() => fail("timeout ao carregar o Google"), timeoutMs);
    s.onload = () => {
      clearTimeout(t);
      if (getGsi()) resolve();
      else fail("Google Identity Services indisponível");
    };
    s.onerror = () => fail("falha ao carregar o script do Google");
    document.head.appendChild(s);
  });
  return gsiPromise;
}

const hex = (b: Uint8Array) => Array.from(b, (x) => x.toString(16).padStart(2, "0")).join("");

/** raw → Supabase; hashed (SHA-256 em hexadecimal) → Google. */
export async function createNoncePair(): Promise<{ raw: string; hashed: string }> {
  const bytes = new Uint8Array(32);
  crypto.getRandomValues(bytes);
  const raw = hex(bytes);
  const digest = await crypto.subtle.digest("SHA-256", new TextEncoder().encode(raw));
  return { raw, hashed: hex(new Uint8Array(digest)) };
}

export type IdTokenClient = {
  auth: {
    signInWithIdToken: (args: {
      provider: "google";
      token: string;
      nonce?: string;
    }) => Promise<{ error: { message: string } | null }>;
  };
};

export function googleSignInErrorText(message: string): string {
  if (/not enabled|unsupported provider|provider is not enabled/i.test(message))
    return "O login com Google ainda não está ativado no Supabase (Authentication → Providers → Google).";
  if (/audience/i.test(message))
    return "O Client ID do Google não está cadastrado no Supabase (Providers → Google → Client IDs).";
  if (/nonce/i.test(message)) return "Falha na verificação de segurança. Recarregue a página e tente de novo.";
  if (/expired|exp\b/i.test(message)) return "A credencial do Google expirou. Tente novamente.";
  return "Não foi possível entrar com o Google. Tente novamente ou use e-mail e senha.";
}

/** Passo 6 do fluxo: troca o ID token do Google por uma sessão do Supabase. */
export async function signInWithGoogleCredential(
  client: IdTokenClient,
  credential: string | undefined,
  rawNonce: string,
): Promise<{ ok: true } | { ok: false; message: string }> {
  if (!credential) return { ok: false, message: "O Google não devolveu a credencial." };
  const { error } = await client.auth.signInWithIdToken({ provider: "google", token: credential, nonce: rawNonce });
  if (error) return { ok: false, message: googleSignInErrorText(error.message) };
  return { ok: true };
}
