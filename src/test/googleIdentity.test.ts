import { describe, expect, it, vi } from "vitest";
import { createHash, webcrypto } from "node:crypto";
import {
  createNoncePair,
  googleSignInErrorText,
  signInWithGoogleCredential,
  type IdTokenClient,
} from "@/lib/googleIdentity";

describe("Entrar com Google (GIS + signInWithIdToken)", () => {
  it("nonce: o Google recebe o SHA-256 em hexadecimal e o Supabase recebe o valor cru", async () => {
    vi.stubGlobal("crypto", webcrypto);
    const a = await createNoncePair();
    const b = await createNoncePair();
    vi.unstubAllGlobals();
    expect(a.raw).toHaveLength(64);
    expect(a.hashed).toBe(createHash("sha256").update(a.raw).digest("hex"));
    expect(a.raw).not.toBe(b.raw);
  });

  it("envia ao Supabase o provider google, o ID token e o nonce cru", async () => {
    const calls: unknown[] = [];
    const client: IdTokenClient = {
      auth: {
        signInWithIdToken: async (args) => {
          calls.push(args);
          return { error: null };
        },
      },
    };
    const r = await signInWithGoogleCredential(client, "token-do-google", "nonce-cru");
    expect(r).toEqual({ ok: true });
    expect(calls).toEqual([{ provider: "google", token: "token-do-google", nonce: "nonce-cru" }]);
  });

  it("sem credencial não chama o Supabase", async () => {
    let called = false;
    const client: IdTokenClient = {
      auth: {
        signInWithIdToken: async () => {
          called = true;
          return { error: null };
        },
      },
    };
    const r = await signInWithGoogleCredential(client, undefined, "n");
    expect(r.ok).toBe(false);
    expect(called).toBe(false);
  });

  it("traduz os erros mais comuns de configuração", async () => {
    expect(googleSignInErrorText("Unsupported provider: provider is not enabled")).toMatch(/ainda não está ativado/);
    expect(googleSignInErrorText("Unacceptable audience in id_token: [abc]")).toMatch(/Client ID/);
    expect(googleSignInErrorText("Nonces mismatch")).toMatch(/segurança/);
    expect(googleSignInErrorText("qualquer outra coisa")).toMatch(/Não foi possível/);
    const client: IdTokenClient = {
      auth: { signInWithIdToken: async () => ({ error: { message: "Unacceptable audience in id_token" } }) },
    };
    const r = await signInWithGoogleCredential(client, "t", "n");
    expect(r.ok).toBe(false);
  });
});
