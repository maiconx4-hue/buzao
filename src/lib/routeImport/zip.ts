import { ImportError, LIMITS } from "./types";

export type ZipEntry = {
  name: string;
  method: number;
  compressedSize: number;
  size: number;
  offset: number;
};

const u16 = (b: Uint8Array, o: number) => (b[o] ?? 0) | ((b[o + 1] ?? 0) << 8);
const u32 = (b: Uint8Array, o: number) =>
  ((b[o] ?? 0) | ((b[o + 1] ?? 0) << 8) | ((b[o + 2] ?? 0) << 16) | ((b[o + 3] ?? 0) << 24)) >>> 0;

const BAD = "Arquivo ZIP inválido ou corrompido.";

/** Lê o diretório central de um ZIP (sem ZIP64, sem senha). */
export function listZip(buf: Uint8Array): ZipEntry[] {
  if (buf.length < 22) throw new ImportError(BAD);
  let eocd = -1;
  const min = Math.max(0, buf.length - 22 - 0xffff);
  for (let i = buf.length - 22; i >= min; i--) {
    if (buf[i] === 0x50 && buf[i + 1] === 0x4b && buf[i + 2] === 0x05 && buf[i + 3] === 0x06) {
      eocd = i;
      break;
    }
  }
  if (eocd < 0) throw new ImportError(BAD);
  const total = u16(buf, eocd + 10);
  const cdOffset = u32(buf, eocd + 16);
  if (total === 0xffff || cdOffset === 0xffffffff) throw new ImportError("ZIP64 não é suportado.");
  if (total > LIMITS.zipEntries) throw new ImportError(`O ZIP tem mais de ${LIMITS.zipEntries} arquivos.`);
  const entries: ZipEntry[] = [];
  let p = cdOffset;
  for (let n = 0; n < total; n++) {
    if (p + 46 > buf.length || u32(buf, p) !== 0x02014b50) throw new ImportError(BAD);
    const flags = u16(buf, p + 8);
    const method = u16(buf, p + 10);
    const comp = u32(buf, p + 20);
    const size = u32(buf, p + 24);
    const nameLen = u16(buf, p + 28);
    const extraLen = u16(buf, p + 30);
    const commentLen = u16(buf, p + 32);
    const offset = u32(buf, p + 42);
    if (flags & 1) throw new ImportError("ZIP protegido por senha não é suportado.");
    if (comp === 0xffffffff || size === 0xffffffff || offset === 0xffffffff)
      throw new ImportError("ZIP64 não é suportado.");
    if (p + 46 + nameLen > buf.length) throw new ImportError(BAD);
    const name = new TextDecoder("utf-8").decode(buf.subarray(p + 46, p + 46 + nameLen)).replace(/\\/g, "/");
    entries.push({ name, method, compressedSize: comp, size, offset });
    p += 46 + nameLen + extraLen + commentLen;
  }
  return entries;
}

export function findEntry(entries: ZipEntry[], name: string): ZipEntry | undefined {
  const want = name.toLowerCase();
  return entries.find((e) => {
    const n = e.name.toLowerCase();
    return n === want || n.endsWith("/" + want);
  });
}

async function inflateRaw(data: Uint8Array, maxBytes: number): Promise<Uint8Array> {
  if (typeof DecompressionStream === "undefined")
    throw new ImportError("Este navegador não consegue descompactar ZIP. Use um navegador atualizado.");
  const src = new ReadableStream<Uint8Array>({
    start(c) {
      c.enqueue(data);
      c.close();
    },
  });
  const ds = new DecompressionStream("deflate-raw") as unknown as ReadableWritablePair<Uint8Array, Uint8Array>;
  const reader = src.pipeThrough(ds).getReader();
  const chunks: Uint8Array[] = [];
  let total = 0;
  for (;;) {
    const { done, value } = await reader.read();
    if (done) break;
    total += value.length;
    if (total > maxBytes) {
      await reader.cancel();
      throw new ImportError("Um arquivo dentro do ZIP é grande demais (possível ZIP malicioso).");
    }
    chunks.push(value);
  }
  const out = new Uint8Array(total);
  let o = 0;
  for (const c of chunks) {
    out.set(c, o);
    o += c.length;
  }
  return out;
}

export async function readEntry(
  buf: Uint8Array,
  e: ZipEntry,
  maxBytes: number = LIMITS.zipEntryBytes,
): Promise<Uint8Array> {
  if (e.size > maxBytes) throw new ImportError(`"${e.name}" é grande demais para importar.`);
  const o = e.offset;
  if (o + 30 > buf.length || u32(buf, o) !== 0x04034b50) throw new ImportError(BAD);
  const start = o + 30 + u16(buf, o + 26) + u16(buf, o + 28);
  const end = start + e.compressedSize;
  if (end > buf.length) throw new ImportError(BAD);
  const data = buf.subarray(start, end);
  if (e.method === 0) return data.slice();
  if (e.method !== 8) throw new ImportError(`Método de compressão ${e.method} não suportado.`);
  const out = await inflateRaw(data, maxBytes);
  if (out.length !== e.size) throw new ImportError(BAD);
  return out;
}

export async function readText(buf: Uint8Array, entries: ZipEntry[], name: string): Promise<string | null> {
  const e = findEntry(entries, name);
  if (!e) return null;
  const bytes = await readEntry(buf, e);
  return new TextDecoder("utf-8").decode(bytes);
}
