/**
 * AegisDID — FAR/TAR measurement on the DEPLOYED face pipeline.
 *
 * WHAT THIS MEASURES
 *   The real thing: face-api.js TinyFaceDetector (inputSize 224, scoreThreshold 0.15) ->
 *   FaceLandmark68Net -> aligned crop -> FaceRecognitionNet, loaded from web/public/models,
 *   i.e. the exact seven weight files that MODEL_HASH commits to. Descriptors then go through
 *   the deployed quantizer (lib/ml/quantize.ts) and the deployed fixed-point dot product, so
 *   the numbers below are in the same units the circuit and the contract compare against.
 *
 *   It deliberately does NOT use tools/generate_lfw_eval.py, which scores dlib's own ResNet-34
 *   through `face_recognition`. That is a different network from the one this app ships, so its
 *   output would be a proxy for the deployed model rather than a measurement of it.
 *
 * HOW IT DIFFERS FROM PRODUCTION (read before quoting any number)
 *   - Input is a still LFW photograph, not a live webcam frame. Liveness is NOT exercised here;
 *     these figures describe the recognition threshold only.
 *   - LFW is celebrity photojournalism: adult, largely Western, studio/press lighting. It is not
 *     representative of a humanitarian enrolment population, so FAR/TAR here does NOT transfer to
 *     field conditions. See docs/MODEL_CARD.md.
 *   - Both images of a pair are stills. In production the enrolment and claim frames come from
 *     different sessions, cameras and lighting, which is strictly harder.
 *
 * INPUT   web/.eval/{images.bin,manifest.json}, produced by tools/lfw_export_raw.py
 * USAGE   node scripts/far_tar_eval.mts            (from web/)
 */

import fs from 'node:fs';
import path from 'node:path';
import { createRequire } from 'node:module';
import { fileURLToPath } from 'node:url';

import {
  quantizeEmbedding,
  computeQuantizedDotProduct,
  cosineToTauQ,
  isTauQSound,
  MIN_TAU_Q,
  MAX_TAU_Q,
} from '../lib/ml/quantize.ts';

const require = createRequire(import.meta.url);
const __dirname = path.dirname(fileURLToPath(import.meta.url));

const tf = require('@tensorflow/tfjs-core');
const faceapi = require('face-api.js');

const EVAL_DIR = path.join(__dirname, '..', '.eval');
const MODELS_DIR = path.join(__dirname, '..', 'public', 'models');
const OUT_JSON = path.join(EVAL_DIR, 'far_tar_results.json');

/**
 * Raw descriptors are cached so re-analysis does not require another ~25 minute inference pass.
 * Cache holds float32 descriptors; the quantization and all statistics are recomputed from them.
 */
const DESC_BIN = path.join(EVAL_DIR, 'descriptors.f32');
const DESC_META = path.join(EVAL_DIR, 'descriptors.json');

/**
 * dlib's published LFW accuracy for this network is 99.38% at a Euclidean descriptor distance
 * threshold of 0.6. Reproducing that is the correctness gate for this harness: if the alignment,
 * pixel range or model loading were wrong, accuracy at 0.6 would collapse and every similarity
 * number below would be meaningless.
 */
const DLIB_THRESHOLD = 0.6;

/** Mirrors lib/ml/face.ts exactly. */
const INPUT_SIZE = 224;
const SCORE_THRESHOLD = 0.15;
const MULTI_FACE_SCORE = 0.4;

interface Manifest {
  height: number;
  width: number;
  channels: number;
  count: number;
  identities: number;
  bytesPerImage: number;
  items: { identity: number; name: string; file: string }[];
}

function loadManifest(): Manifest {
  if (!fs.existsSync(path.join(EVAL_DIR, 'manifest.json'))) {
    console.error(`No corpus at ${EVAL_DIR}. Generate it first:`);
    console.error('  cd tools && ./venv/bin/python lfw_export_raw.py');
    process.exit(2);
  }
  return JSON.parse(fs.readFileSync(path.join(EVAL_DIR, 'manifest.json'), 'utf8')) as Manifest;
}

async function loadNets() {
  faceapi.env.monkeyPatch({
    readFile: (p: string) => Promise.resolve(fs.readFileSync(p)),
    Canvas: class {},
    Image: class {},
    ImageData: class {},
    createCanvasElement: () => {
      throw new Error('canvas unavailable — this harness feeds tensors, not canvases');
    },
    createImageElement: () => {
      throw new Error('image element unavailable — this harness feeds tensors');
    },
    fetch: () => {
      throw new Error('no network in the eval harness');
    },
  });

  await faceapi.nets.tinyFaceDetector.loadFromDisk(MODELS_DIR);
  await faceapi.nets.faceLandmark68Net.loadFromDisk(MODELS_DIR);
  await faceapi.nets.faceRecognitionNet.loadFromDisk(MODELS_DIR);

  for (const [name, net] of [
    ['tinyFaceDetector', faceapi.nets.tinyFaceDetector],
    ['faceLandmark68Net', faceapi.nets.faceLandmark68Net],
    ['faceRecognitionNet', faceapi.nets.faceRecognitionNet],
  ] as [string, { isLoaded: boolean }][]) {
    if (!net.isLoaded) throw new Error(`${name} failed to load from ${MODELS_DIR}`);
  }
}

/**
 * Descriptor for one image via the deployed code path, including its multi-face rejection and
 * largest-detection selection. Returns null when no face is found (production fails closed here).
 */
async function descriptorFor(
  rgb: Buffer,
  h: number,
  w: number
): Promise<{ descriptor: Float32Array; score: number } | 'none' | 'multi'> {
  // tf.browser.fromPixels() yields 0..255 in the browser; match that range exactly.
  const data = new Float32Array(h * w * 3);
  for (let i = 0; i < data.length; i++) data[i] = rgb[i];
  const tensor = tf.tensor3d(data, [h, w, 3]);

  try {
    const options = new faceapi.TinyFaceDetectorOptions({
      inputSize: INPUT_SIZE,
      scoreThreshold: SCORE_THRESHOLD,
    });
    const results = await faceapi
      .detectAllFaces(tensor, options)
      .withFaceLandmarks()
      .withFaceDescriptors();

    const strong = results.filter(
      (r: { detection: { score: number } }) => r.detection.score >= MULTI_FACE_SCORE
    );
    if (strong.length > 1) return 'multi';

    if (!results.length) return 'none';
    const primary = results.reduce(
      (
        best: { detection: { box: { width: number; height: number } } },
        cur: { detection: { box: { width: number; height: number } } }
      ) =>
        cur.detection.box.width * cur.detection.box.height >
        best.detection.box.width * best.detection.box.height
          ? cur
          : best
    );
    if (!primary?.descriptor) return 'none';
    return { descriptor: primary.descriptor, score: primary.detection.score };
  } finally {
    tensor.dispose();
  }
}

/** Fraction of a sorted-ascending array that is >= t. */
function fractionAtLeast(sorted: Int32Array, t: number): number {
  let lo = 0;
  let hi = sorted.length;
  while (lo < hi) {
    const mid = (lo + hi) >> 1;
    if (sorted[mid] < t) lo = mid + 1;
    else hi = mid;
  }
  return (sorted.length - lo) / sorted.length;
}

interface Collected {
  /** One 128-float descriptor per usable image, flattened. */
  raw: Float32Array;
  identity: number[];
  scores: number[];
  noFace: number;
  multiFace: number;
  cached: boolean;
}

/**
 * Run the deployed pipeline over the corpus, or reload a previous run's descriptors.
 *
 * The cache is keyed on the corpus size so a regenerated corpus cannot be silently scored with
 * stale descriptors. It stores the RAW float32 model output — every statistic below (quantization,
 * fixed-point dots, Euclidean distances) is recomputed from it, so re-analysis never needs another
 * inference pass, and nothing measured is baked into the cache.
 */
async function collectDescriptors(manifest: Manifest): Promise<Collected> {
  if (fs.existsSync(DESC_BIN) && fs.existsSync(DESC_META)) {
    const meta = JSON.parse(fs.readFileSync(DESC_META, 'utf8'));
    if (meta.corpusCount === manifest.count && meta.dims === 128) {
      const bytes = fs.readFileSync(DESC_BIN);
      const raw = new Float32Array(
        bytes.buffer.slice(bytes.byteOffset, bytes.byteOffset + bytes.byteLength)
      );
      if (raw.length === meta.identity.length * 128) {
        console.log(
          `reusing cached descriptors: ${meta.identity.length} usable ` +
            `(delete ${path.relative(process.cwd(), DESC_BIN)} to force re-inference)`
        );
        return {
          raw,
          identity: meta.identity,
          scores: meta.scores,
          noFace: meta.noFace,
          multiFace: meta.multiFace,
          cached: true,
        };
      }
    }
    console.log('cached descriptors do not match the current corpus — re-running inference');
  }

  console.log(`loading deployed nets from ${MODELS_DIR} ...`);
  await loadNets();
  console.log('nets loaded (tinyFaceDetector, faceLandmark68Net, faceRecognitionNet)');

  const fd = fs.openSync(path.join(EVAL_DIR, 'images.bin'), 'r');
  const buf = Buffer.allocUnsafe(manifest.bytesPerImage);

  const chunks: Float32Array[] = [];
  const identity: number[] = [];
  const scores: number[] = [];
  let noFace = 0;
  let multiFace = 0;
  const t0 = Date.now();

  try {
    for (let i = 0; i < manifest.count; i++) {
      fs.readSync(fd, buf, 0, manifest.bytesPerImage, i * manifest.bytesPerImage);
      const r = await descriptorFor(buf, manifest.height, manifest.width);

      if (r === 'none') {
        noFace++;
      } else if (r === 'multi') {
        multiFace++;
      } else {
        chunks.push(Float32Array.from(r.descriptor));
        identity.push(manifest.items[i].identity);
        scores.push(r.score);
      }

      if ((i + 1) % 25 === 0 || i + 1 === manifest.count) {
        const el = (Date.now() - t0) / 1000;
        const rate = (i + 1) / el;
        console.log(
          `  ${i + 1}/${manifest.count}  kept=${chunks.length} noFace=${noFace} ` +
            `multi=${multiFace}  ${rate.toFixed(2)} img/s  ` +
            `eta ${Math.round((manifest.count - i - 1) / rate)}s`
        );
      }
    }
  } finally {
    fs.closeSync(fd);
  }

  const raw = new Float32Array(chunks.length * 128);
  chunks.forEach((c, i) => raw.set(c, i * 128));
  fs.writeFileSync(DESC_BIN, Buffer.from(raw.buffer, raw.byteOffset, raw.byteLength));
  fs.writeFileSync(
    DESC_META,
    JSON.stringify({ corpusCount: manifest.count, dims: 128, identity, scores, noFace, multiFace })
  );

  return { raw, identity, scores, noFace, multiFace, cached: false };
}

/** Euclidean distance between two descriptors held in a flat buffer. */
function euclid(raw: Float32Array, a: number, b: number): number {
  let ss = 0;
  for (let k = 0; k < 128; k++) {
    const d = raw[a * 128 + k] - raw[b * 128 + k];
    ss += d * d;
  }
  return Math.sqrt(ss);
}

async function main() {
  const manifest = loadManifest();
  console.log(
    `corpus: ${manifest.count} images, ${manifest.identities} identities, ` +
      `${manifest.width}x${manifest.height}x${manifest.channels}`
  );

  const col = await collectDescriptors(manifest);
  const { raw, scores, noFace, multiFace } = col;
  const n = col.identity.length;

  const detectionRate = (n + multiFace) / manifest.count;
  console.log(
    `\ndetection: ${n} usable, ${noFace} no-face, ${multiFace} multi-face ` +
      `(detection rate ${(detectionRate * 100).toFixed(1)}%)`
  );
  if (n < 50) {
    console.error('FAIL: too few usable descriptors to measure anything.');
    process.exit(1);
  }

  const norms: number[] = [];
  for (let i = 0; i < n; i++) {
    let ss = 0;
    for (let k = 0; k < 128; k++) ss += raw[i * 128 + k] * raw[i * 128 + k];
    norms.push(Math.sqrt(ss));
  }
  const kept = Array.from({ length: n }, (_, i) => ({
    identity: col.identity[i],
    u: quantizeEmbedding(raw.subarray(i * 128, i * 128 + 128)),
  }));

  const meanNorm = norms.reduce((a, b) => a + b, 0) / norms.length;
  console.log(
    `raw descriptor L2 norm: mean ${meanNorm.toFixed(4)} ` +
      `min ${Math.min(...norms).toFixed(4)} max ${Math.max(...norms).toFixed(4)}`
  );
  console.log(
    `detector score: mean ${(scores.reduce((a, b) => a + b, 0) / scores.length).toFixed(3)} ` +
      `min ${Math.min(...scores).toFixed(3)}`
  );

  // ---- CORRECTNESS GATE: reproduce dlib's published LFW accuracy at Euclidean 0.6.
  // If alignment, pixel range or weight loading were wrong, this collapses toward chance and no
  // number further down means anything. Balanced accuracy is used because impostor pairs
  // outnumber genuine ones by ~300x, which would make raw accuracy ~100% no matter what.
  const eucGen: number[] = [];
  const eucImp: number[] = [];
  for (let i = 0; i < n; i++) {
    for (let j = i + 1; j < n; j++) {
      const d = euclid(raw, i, j);
      if (col.identity[i] === col.identity[j]) eucGen.push(d);
      else eucImp.push(d);
    }
  }
  const tar06 = eucGen.filter((d) => d <= DLIB_THRESHOLD).length / eucGen.length;
  const far06 = eucImp.filter((d) => d <= DLIB_THRESHOLD).length / eucImp.length;
  const balancedAcc06 = (tar06 + (1 - far06)) / 2;
  const mean = (a: number[]) => a.reduce((x, y) => x + y, 0) / a.length;
  console.log(
    `\nEuclidean distance (dlib's native metric): genuine mean ${mean(eucGen).toFixed(4)}, ` +
      `impostor mean ${mean(eucImp).toFixed(4)}`
  );
  console.log(
    `correctness gate @ dist<=${DLIB_THRESHOLD}: TAR ${(tar06 * 100).toFixed(2)}% ` +
      `FAR ${(far06 * 100).toFixed(2)}% balanced accuracy ${(balancedAcc06 * 100).toFixed(2)}% ` +
      `(dlib publishes 99.38% on LFW)`
  );
  const gatePassed = balancedAcc06 >= 0.98;
  if (!gatePassed) {
    console.error(
      `\nFAIL: balanced accuracy ${(balancedAcc06 * 100).toFixed(2)}% at the reference threshold ` +
        `is far below dlib's published 99.38%. The pipeline is misconfigured; the FAR/TAR figures ` +
        `below would be meaningless. Not writing results.`
    );
    process.exit(1);
  }
  console.log('GATE PASSED — pipeline reproduces the reference accuracy; similarity stats follow.');

  // ---- all-pairs fixed-point dot products, in the circuit's own units
  const genuine: number[] = [];
  const impostor: number[] = [];
  for (let i = 0; i < kept.length; i++) {
    for (let j = i + 1; j < kept.length; j++) {
      const d = computeQuantizedDotProduct(kept[i].u, kept[j].u);
      if (kept[i].identity === kept[j].identity) genuine.push(d);
      else impostor.push(d);
    }
  }
  const g = Int32Array.from(genuine).sort();
  const im = Int32Array.from(impostor).sort();
  console.log(`pairs: ${g.length} genuine, ${im.length} impostor`);

  const stat = (a: Int32Array) => {
    let s = 0;
    for (const v of a) s += v;
    const mean = s / a.length;
    return {
      mean,
      meanCos: mean / 16129,
      min: a[0],
      p1: a[Math.floor(a.length * 0.01)],
      median: a[Math.floor(a.length * 0.5)],
      p99: a[Math.floor(a.length * 0.99)],
      max: a[a.length - 1],
    };
  };
  const gs = stat(g);
  const ims = stat(im);
  console.log(
    `\ngenuine  dot: mean ${gs.mean.toFixed(0)} (cos ${gs.meanCos.toFixed(4)})  ` +
      `min ${gs.min} p1 ${gs.p1} median ${gs.median} max ${gs.max}`
  );
  console.log(
    `impostor dot: mean ${ims.mean.toFixed(0)} (cos ${ims.meanCos.toFixed(4)})  ` +
      `min ${ims.min} median ${ims.median} p99 ${ims.p99} max ${ims.max}`
  );

  // ---- FAR/TAR sweep, reported in tauQ (what a policy actually stores)
  console.log('\n' + '='.repeat(78));
  console.log('  cosine     tauQ        TAR            FAR          sound?');
  console.log('='.repeat(78));
  const rows: {
    cosine: number;
    tauQ: number;
    tar: number;
    far: number;
    sound: boolean;
  }[] = [];
  for (let c = 0.2; c <= 0.951; c += 0.05) {
    const tauQ = cosineToTauQ(c);
    const tar = fractionAtLeast(g, tauQ);
    const far = fractionAtLeast(im, tauQ);
    rows.push({ cosine: +c.toFixed(2), tauQ, tar, far, sound: isTauQSound(tauQ) });
    console.log(
      `  ${c.toFixed(2)}     ${String(tauQ).padStart(6)}    ` +
        `${(tar * 100).toFixed(2).padStart(6)}%    ` +
        `${(far * 100).toFixed(4).padStart(9)}%    ${isTauQSound(tauQ) ? 'yes' : 'NO'}`
    );
  }
  console.log('='.repeat(78));

  // ---- operating points: smallest tauQ meeting a FAR target (maximizes TAR at that FAR)
  const targets = [0.01, 0.001, 0.0001, 0];
  const operating: Record<string, unknown> = {};
  console.log('\nOperating points (smallest tauQ meeting the FAR target => highest TAR):');
  for (const target of targets) {
    let chosen: number | null = null;
    for (let t = MIN_TAU_Q; t <= MAX_TAU_Q; t++) {
      if (fractionAtLeast(im, t) <= target) {
        chosen = t;
        break;
      }
    }
    if (chosen === null) {
      console.log(`  FAR <= ${target}: UNREACHABLE inside the sound tauQ range [1, ${MAX_TAU_Q}]`);
      operating[`far_${target}`] = null;
      continue;
    }
    const tar = fractionAtLeast(g, chosen);
    const far = fractionAtLeast(im, chosen);
    const nFalseAccepts = Math.round(far * im.length);
    console.log(
      `  FAR <= ${String(target).padEnd(7)} -> tauQ ${String(chosen).padStart(5)} ` +
        `(cos ${(chosen / 16129).toFixed(4)})  TAR ${(tar * 100).toFixed(2)}%  ` +
        `measured FAR ${(far * 100).toFixed(5)}% (${nFalseAccepts}/${im.length})`
    );
    operating[`far_${target}`] = {
      tauQ: chosen,
      cosine: +(chosen / 16129).toFixed(4),
      tar,
      far,
      falseAccepts: nFalseAccepts,
    };
  }

  // Equal error rate. far/frr here are FRACTIONS, so the EER is their mean — scale to a percentage
  // only for display. (Dividing by 200 as if they were already percentages understates it by 10x.)
  let eer = { tauQ: 0, frr: 1, far: 1, gap: 1 };
  for (let t = MIN_TAU_Q; t <= MAX_TAU_Q; t++) {
    const frr = 1 - fractionAtLeast(g, t);
    const far = fractionAtLeast(im, t);
    const gap = Math.abs(frr - far);
    if (gap < eer.gap) eer = { tauQ: t, frr, far, gap };
  }
  const eerValue = (eer.far + eer.frr) / 2;
  console.log(
    `  EER ~ ${(eerValue * 100).toFixed(4)}% at tauQ ${eer.tauQ} ` +
      `(cos ${(eer.tauQ / 16129).toFixed(4)}): FAR ${(eer.far * 100).toFixed(4)}% ` +
      `FRR ${(eer.frr * 100).toFixed(4)}%`
  );

  // ---- resolution floor: with N impostor pairs, no FAR below 1/N is distinguishable from 0
  console.log(
    `\nResolution floor: ${im.length} impostor pairs, so the smallest non-zero FAR this corpus ` +
      `can resolve is 1/${im.length} = ${(1 / im.length).toExponential(2)}. ` +
      `A measured FAR of 0 means "below that floor", NOT "zero".`
  );

  fs.writeFileSync(
    OUT_JSON,
    JSON.stringify(
      {
        corpus: {
          source: 'LFW funneled',
          images: manifest.count,
          identities: manifest.identities,
          usableDescriptors: kept.length,
          noFace,
          multiFace,
          detectionRate,
        },
        descriptorNorm: { mean: meanNorm, min: Math.min(...norms), max: Math.max(...norms) },
        referenceGate: {
          metric: 'Euclidean descriptor distance (dlib native)',
          threshold: DLIB_THRESHOLD,
          dlibPublishedLfwAccuracy: 0.9938,
          genuineMeanDistance: mean(eucGen),
          impostorMeanDistance: mean(eucImp),
          tar: tar06,
          far: far06,
          balancedAccuracy: balancedAcc06,
          passed: gatePassed,
        },
        pairs: { genuine: g.length, impostor: im.length },
        genuineDot: gs,
        impostorDot: ims,
        sweep: rows,
        operating,
        eer: { ...eer, eer: eerValue },
        resolutionFloor: 1 / im.length,
        pipeline: {
          detector: `TinyFaceDetector inputSize=${INPUT_SIZE} scoreThreshold=${SCORE_THRESHOLD}`,
          landmarks: 'FaceLandmark68Net',
          recognition: 'FaceRecognitionNet (128-d)',
          modelsDir: 'web/public/models (the files MODEL_HASH commits to)',
          quantizer: 'lib/ml/quantize.ts quantizeEmbedding + computeQuantizedDotProduct',
        },
      },
      null,
      2
    )
  );
  console.log(`\nwrote ${OUT_JSON}`);
}

main().catch((e) => {
  console.error('EVAL FAILED:', e);
  process.exit(1);
});
