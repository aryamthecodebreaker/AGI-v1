// MiniLM embedding singleton.
//
// We pin the transformers.js model cache to data/models/ BEFORE any pipeline
// call so the project stays portable. The feature-extraction pipeline with
// { pooling:'mean', normalize:true } returns an already-pooled L2-normalized
// vector — perfect for cosine similarity.

import { env, pipeline, type FeatureExtractionPipeline } from '@huggingface/transformers';
import { config } from '../config.js';
import { logger } from '../logger.js';
import { EMBED_DIM } from '../storage/vector.js';

// Pin cache dir. This must happen before any pipeline() call.
env.cacheDir = config.modelsDir;
env.localModelPath = config.modelsDir;
// Allow remote downloads (first-run). After warm, can run fully offline.
env.allowRemoteModels = true;

let pipePromise: Promise<FeatureExtractionPipeline> | null = null;

async function getPipeline(): Promise<FeatureExtractionPipeline> {
  if (!pipePromise) {
    logger.info({ model: config.embedModelId, cacheDir: config.modelsDir }, 'loading embedding model');
    pipePromise = pipeline('feature-extraction', config.embedModelId, {
      // quantized is the default for most models; keep it small.
    }) as Promise<FeatureExtractionPipeline>;
    pipePromise
      .then(() => logger.info({ model: config.embedModelId }, 'embedding model ready'))
      .catch((err) => {
        logger.error({ err }, 'failed to load embedding model');
        pipePromise = null;
      });
  }
  return pipePromise;
}

/**
 * Embed a single string. Returns a Float32Array of length EMBED_DIM (384 for MiniLM).
 * Always L2-normalized and mean-pooled.
 */
export async function embed(text: string): Promise<Float32Array> {
  const pipe = await getPipeline();
  const out = await pipe(text, { pooling: 'mean', normalize: true });
  // out.data is a TypedArray view; copy into a fresh Float32Array to detach from the tensor.
  const vec = Float32Array.from(out.data as Float32Array);
  if (vec.length !== EMBED_DIM) {
    throw new Error(`embedding dim mismatch: got ${vec.length}, expected ${EMBED_DIM}`);
  }
  return vec;
}

/**
 * Embed a batch of strings in one forward pass. Cheaper than N serial calls.
 */
export async function embedBatch(texts: string[]): Promise<Float32Array[]> {
  if (texts.length === 0) return [];
  const pipe = await getPipeline();
  const out = await pipe(texts, { pooling: 'mean', normalize: true });
  // For batched input, out.data is [batch*dim] flat; dims is [batch, dim].
  const dims = (out as unknown as { dims: number[] }).dims;
  const [batch, dim] = dims;
  if (dim !== EMBED_DIM) {
    throw new Error(`embedding dim mismatch: got ${dim}, expected ${EMBED_DIM}`);
  }
  const flat = out.data as Float32Array;
  const result: Float32Array[] = [];
  for (let i = 0; i < batch!; i++) {
    result.push(Float32Array.from(flat.subarray(i * dim!, (i + 1) * dim!)));
  }
  return result;
}

/**
 * Force-load the model (useful for warm-up scripts so the first real request
 * doesn't pay the download cost).
 */
export async function warmEmbeddings(): Promise<void> {
  await embed('warmup');
}
