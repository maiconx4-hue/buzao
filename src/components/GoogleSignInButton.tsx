import { useEffect, useRef, useState } from "react";
import { supabase } from "@/integrations/supabase/client";
import {
  createNoncePair,
  getGsi,
  loadGoogleIdentity,
  signInWithGoogleCredential,
  type GoogleCredentialResponse,
} from "@/lib/googleIdentity";

/**
 * Botão oficial "Fazer login com o Google" (Google Identity Services).
 * O texto do botão é definido pelo Google; ao autorizar, a credencial vira sessão no Supabase.
 */
export function GoogleSignInButton({
  clientId,
  onSignedIn,
  onError,
}: {
  clientId: string;
  onSignedIn: () => void;
  onError: (message: string) => void;
}) {
  const box = useRef<HTMLDivElement>(null);
  const [state, setState] = useState<"loading" | "ready" | "error">("loading");
  const [busy, setBusy] = useState(false);
  const handlers = useRef({ onSignedIn, onError });
  handlers.current = { onSignedIn, onError };

  useEffect(() => {
    let cancelled = false;
    void (async () => {
      try {
        await loadGoogleIdentity();
        const el = box.current;
        const gsi = getGsi();
        if (cancelled || !el || !gsi) return;
        const nonce = await createNoncePair();
        if (cancelled) return;
        gsi.initialize({
          client_id: clientId,
          nonce: nonce.hashed,
          ux_mode: "popup",
          use_fedcm_for_prompt: true,
          itp_support: true,
          auto_select: false,
          callback: (resp: GoogleCredentialResponse) => {
            setBusy(true);
            void signInWithGoogleCredential(supabase, resp.credential, nonce.raw)
              .then((r) => {
                if (r.ok) handlers.current.onSignedIn();
                else handlers.current.onError(r.message);
              })
              .catch(() => handlers.current.onError("Não foi possível entrar com o Google."))
              .finally(() => setBusy(false));
          },
        });
        gsi.renderButton(el, {
          type: "standard",
          theme: "outline",
          size: "large",
          text: "signin_with",
          shape: "pill",
          logo_alignment: "left",
          locale: "pt-BR",
          width: Math.min(Math.max(el.clientWidth || 300, 200), 400),
        });
        setState("ready");
      } catch {
        if (!cancelled) setState("error");
      }
    })();
    return () => {
      cancelled = true;
      getGsi()?.cancel();
    };
  }, [clientId]);

  return (
    <div className="space-y-1">
      <div ref={box} className="flex min-h-[44px] justify-center" aria-busy={busy || state === "loading"} />
      {state === "error" && (
        <p className="text-center text-xs text-muted-foreground">
          Não foi possível carregar o login do Google. Verifique a conexão ou use e-mail e senha.
        </p>
      )}
      {busy && <p className="text-center text-xs text-muted-foreground">Entrando…</p>}
    </div>
  );
}
