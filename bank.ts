/**
 * Reference bank source: fetched at runtime and cached on disk, never bundled.
 *
 * Integrity comes from the source's own content addressing — every chunk is
 * named `<file>.<sha256(compressed)[:16]>.<index>.zst`, so the expected digest
 * is read from the manifest and checked against the downloaded bytes. Set
 * PI_MODEL_TRACE_BANK_SHA256 to also pin the decompressed payload, and
 * PI_MODEL_TRACE_BANK=<file> to skip the network entirely.
 *
 * Bank data: https://github.com/Ikaleio/lm-detector (MIT), which credits
 * xqy2006/ModelTrace for the underlying method and reference data.
 */

import { createHash } from "node:crypto";
import { mkdir, readFile, rename, writeFile } from "node:fs/promises";
import { homedir } from "node:os";
import { join } from "node:path";
import { zstdDecompressSync } from "node:zlib";

import { DIMENSION, type FingerprintBank } from "./fingerprint.ts";

const ENDPOINT = "https://lm.ikale.io/data/";
const BANK_NAME = "unified_bank.json";
const BLOCK_DIMENSION = 74;
const FETCH_TIMEOUT_MS = 30 * 1000;

export const CACHE_DIRECTORY = join(homedir(), ".cache", "pi-model-trace-direct");

interface CacheMeta {
  chunks: string[];
  sha256: string;
  fetched_at: string;
}

/** `unified_bank.json.a4cdbed6227079f4.0.zst` → `a4cdbed6227079f4`. */
export function chunkDigest(chunkName: string): string {
  const digest = chunkName.split(".").at(-3);
  if (!digest || !/^[0-9a-f]{16}$/.test(digest))
    throw new Error(`Reference bank chunk name is malformed: ${chunkName}`);
  return digest;
}

/** The manifest's own digest for a chunk, checked against the bytes we got. */
export function verifyChunk(chunkName: string, bytes: Uint8Array): void {
  const actual = createHash("sha256").update(bytes).digest("hex").slice(0, 16);
  const expected = chunkDigest(chunkName);
  if (actual !== expected)
    throw new Error(`Reference bank chunk failed its checksum: ${chunkName} (want ${expected}, got ${actual})`);
}

/**
 * Reject a bank that would break scoring half-way through a run. These are the
 * shape invariants the scorer indexes into, not a schema validator.
 */
export function validateBank(bank: FingerprintBank): FingerprintBank {
  const schema = (bank as FingerprintBank & { schema?: string })?.schema;
  if (schema && schema !== "robust-number-fingerprint-bank")
    throw new Error(`Unsupported reference bank schema: ${schema}`);
  const models = bank?.models;
  if (!Array.isArray(models) || !models.length) throw new Error("Reference bank has no models");
  checkModelOrder(bank, models.length);
  checkFeatureShapes(bank, models.length);
  for (const queries of ["1", "2", "3"])
    if (!Number.isFinite(bank.calibration?.[queries]?.beta))
      throw new Error(`Reference bank is missing the ${queries}-answer calibration`);
  return bank;
}

function checkModelOrder(bank: FingerprintBank, expected: number): void {
  if (bank.robust.model_order.length !== expected)
    throw new Error("Reference bank model_order does not match its model list");
  bank.models.forEach((model, index) => {
    if (bank.robust.model_order[index] !== model.id)
      throw new Error(`Reference bank model_order is out of step at index ${index}`);
    if (model.counts?.length !== DIMENSION)
      throw new Error(`Reference bank model ${model.id} has ${model.counts?.length} histogram bins`);
  });
}

function checkFeatureShapes(bank: FingerprintBank, expected: number): void {
  const blocks = bank.robust.ordered_blocks;
  if (!blocks) throw new Error("Reference bank has no ordered-block features");
  const check = (name: string, matrix: number[][] | undefined, width: number) => {
    if (!matrix || matrix.length !== expected || matrix.some((row) => row.length !== width))
      throw new Error(`Reference bank ${name} is not ${expected}x${width}`);
  };
  check("hellinger.centroids", bank.robust.hellinger.centroids, DIMENSION);
  check("ordered_blocks.centroids", blocks.centroids, BLOCK_DIMENSION);
  if (blocks.environment_centroids.some((env) => env.length !== expected))
    throw new Error("Reference bank environment templates do not match its model list");
}

/** Parse and validate, naming where the bank came from when it is unusable. */
function parseBank(text: string, source: string): FingerprintBank {
  try {
    return validateBank(JSON.parse(text) as FingerprintBank);
  } catch (error) {
    throw new Error(
      `Reference bank from ${source} is unusable: ${error instanceof Error ? error.message : String(error)}`,
    );
  }
}

async function readManifest(): Promise<string[]> {
  const response = await fetch(`${ENDPOINT}manifest.json`, {
    signal: AbortSignal.timeout(FETCH_TIMEOUT_MS),
  });
  if (!response.ok) throw new Error(`Reference manifest returned HTTP ${response.status}`);
  const manifest = (await response.json()) as Record<string, string[]>;
  const chunks = manifest[BANK_NAME];
  if (!Array.isArray(chunks) || !chunks.length)
    throw new Error(`Reference manifest lists no chunks for ${BANK_NAME}`);
  return chunks;
}

async function downloadBank(chunks: string[]): Promise<Buffer> {
  const parts: Buffer[] = [];
  for (const name of chunks) {
    const response = await fetch(`${ENDPOINT}chunks/${name}`, {
      signal: AbortSignal.timeout(FETCH_TIMEOUT_MS),
    });
    if (!response.ok) throw new Error(`Reference bank chunk ${name} returned HTTP ${response.status}`);
    const bytes = Buffer.from(await response.arrayBuffer());
    verifyChunk(name, bytes);
    parts.push(bytes);
  }
  return zstdDecompressSync(Buffer.concat(parts));
}

async function readCache(): Promise<{ meta: CacheMeta; bank: FingerprintBank } | undefined> {
  try {
    const meta = JSON.parse(
      await readFile(join(CACHE_DIRECTORY, "bank.meta.json"), "utf8"),
    ) as CacheMeta;
    const bytes = await readFile(join(CACHE_DIRECTORY, "bank.json"));
    if (createHash("sha256").update(bytes).digest("hex") !== meta.sha256) return undefined;
    return { meta, bank: parseBank(bytes.toString("utf8"), `cache ${CACHE_DIRECTORY}`) };
  } catch {
    return undefined;
  }
}

/** Best effort: a read-only home directory must not fail a probe. */
async function writeCache(chunks: string[], sha256: string, raw: Buffer): Promise<void> {
  try {
    await mkdir(CACHE_DIRECTORY, { recursive: true });
    const meta: CacheMeta = { chunks, sha256, fetched_at: new Date().toISOString() };
    await writeFile(join(CACHE_DIRECTORY, "bank.json.tmp"), raw);
    await writeFile(join(CACHE_DIRECTORY, "bank.meta.json.tmp"), `${JSON.stringify(meta)}\n`);
    await rename(join(CACHE_DIRECTORY, "bank.json.tmp"), join(CACHE_DIRECTORY, "bank.json"));
    await rename(join(CACHE_DIRECTORY, "bank.meta.json.tmp"), join(CACHE_DIRECTORY, "bank.meta.json"));
  } catch {
    // cache is optional
  }
}

export function loadBank(): Promise<FingerprintBank> {
  bankPromise ??= fetchBank();
  return bankPromise;
}

let bankPromise: Promise<FingerprintBank> | undefined;

async function fetchBank(): Promise<FingerprintBank> {
  const override = process.env.PI_MODEL_TRACE_BANK;
  if (override) return parseBank(await readFile(override, "utf8"), override);

  const cached = await readCache();
  let chunks: string[];
  try {
    chunks = await readManifest();
  } catch (error) {
    // A stale bank beats no bank when the endpoint is unreachable.
    if (cached) return cached.bank;
    throw new Error(
      `Cannot reach the reference bank at ${ENDPOINT} and nothing is cached yet. ` +
        `Set PI_MODEL_TRACE_BANK to a local bank file to work offline. ` +
        `(${error instanceof Error ? error.message : String(error)})`,
    );
  }
  if (cached && cached.meta.chunks.join() === chunks.join()) return cached.bank;

  const raw = await downloadBank(chunks);
  const sha256 = createHash("sha256").update(raw).digest("hex");
  const pinned = process.env.PI_MODEL_TRACE_BANK_SHA256;
  if (pinned && pinned !== sha256)
    throw new Error(`Reference bank does not match PI_MODEL_TRACE_BANK_SHA256 (want ${pinned}, got ${sha256})`);

  const bank = parseBank(raw.toString("utf8"), `${ENDPOINT}chunks/${chunks.join(", ")} (sha256 ${sha256})`);
  await writeCache(chunks, sha256, raw);
  return bank;
}
