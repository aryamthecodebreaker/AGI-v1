/**
 * Vector utilities for the STORAGE brain.
 *
 * Embeddings are stored as BLOBs (raw Float32Array bytes). We read them back as typed-array
 * views, never mutate the views, and compute cosine similarity in JS. For the scale we care
 * about (tens of thousands of rows × 384 dims) this is milliseconds per query — a native
 * vector extension would be overkill and brittle on Windows.
 */

export const EMBED_DIM = 384; // Xenova/all-MiniLM-L6-v2

export function embeddingToBlob(vec: Float32Array): Buffer {
  if (vec.length === 0) return Buffer.alloc(0);
  // Use the underlying ArrayBuffer slice in case vec is a view into a larger buffer.
  return Buffer.from(vec.buffer, vec.byteOffset, vec.byteLength);
}

export function blobToEmbedding(buf: Buffer | null | undefined): Float32Array | null {
  if (!buf || buf.byteLength === 0) return null;
  // Copy into a fresh Float32Array so callers can treat it as an owned value.
  const out = new Float32Array(buf.byteLength / 4);
  const view = new Float32Array(buf.buffer, buf.byteOffset, buf.byteLength / 4);
  out.set(view);
  return out;
}

/** Cosine similarity for two vectors of the same length. */
export function cosineSim(a: Float32Array, b: Float32Array): number {
  if (a.length !== b.length) return 0;
  let dot = 0;
  let na = 0;
  let nb = 0;
  for (let i = 0; i < a.length; i++) {
    const x = a[i]!;
    const y = b[i]!;
    dot += x * y;
    na += x * x;
    nb += y * y;
  }
  if (na === 0 || nb === 0) return 0;
  return dot / (Math.sqrt(na) * Math.sqrt(nb));
}

/** Cheap L2 normalization — used as a safety net in case a backend returns un-normalized vectors. */
export function l2Normalize(v: Float32Array): Float32Array {
  let sum = 0;
  for (let i = 0; i < v.length; i++) sum += v[i]! * v[i]!;
  const norm = Math.sqrt(sum) || 1;
  const out = new Float32Array(v.length);
  for (let i = 0; i < v.length; i++) out[i] = v[i]! / norm;
  return out;
}
