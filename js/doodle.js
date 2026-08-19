/**
 * G-Doodle in the browser.
 *
 * The first model on this site that does not need the Mac at home to be awake:
 * the weights are downloaded once, and every stroke after that is computed on
 * the visitor's own machine. Chat and Image Studio both go dark when the Mac
 * sleeps; this screen does not.
 *
 * The exported graph is a single decode step — (token, position, past) ->
 * (logits, present) — so the generation loop lives here, in JavaScript. That is
 * what makes the KV cache usable: without it, a 400-token sketch would re-read
 * its own prefix 400 times, which on a phone is the difference between a
 * drawing that appears and one that never finishes.
 *
 * Nothing here fakes a drawing. If the weights are not on the server yet, the
 * caller is told exactly that and draws nothing — same rule as the rest of the
 * site.
 */

const ORT_VERSION = '1.20.1';
const ORT_BASE = `https://cdn.jsdelivr.net/npm/onnxruntime-web@${ORT_VERSION}/dist/`;
const MODEL_DIR = 'models/';

export const state = {
  status: 'idle',     // idle | loading | ready | missing | error
  detail: '',
  bytes: 0,
};

let session = null;
let meta = null;
let prompts = null;
let loadPromise = null;

/* -------------------------------------------------------------- loading -- */

/**
 * Pull onnxruntime-web off the CDN as a plain script.
 *
 * The UMD build rather than an ESM import, because the runtime also has to
 * fetch its own .wasm binaries at run time and needs to be told where they
 * live — `wasmPaths` has to be set on the same object the loader will use.
 */
function loadRuntime() {
  if (window.ort) return Promise.resolve(window.ort);
  return new Promise((resolve, reject) => {
    const tag = document.createElement('script');
    tag.src = `${ORT_BASE}ort.min.js`;
    tag.onload = () => {
      if (!window.ort) return reject(new Error('runtime loaded without ort'));
      window.ort.env.wasm.wasmPaths = ORT_BASE;
      /* One thread. Cross-origin isolation is not set on this host, so the
         threaded build would silently fall back anyway, and asking for threads
         we cannot have only costs a failed probe. */
      window.ort.env.wasm.numThreads = 1;
      resolve(window.ort);
    };
    tag.onerror = () => reject(new Error('nie udało się pobrać onnxruntime-web'));
    document.head.appendChild(tag);
  });
}

async function fetchJSON(url) {
  const r = await fetch(url);
  if (!r.ok) throw Object.assign(new Error(`${url}: ${r.status}`), { status: r.status });
  return r.json();
}

/** Download with progress, because 19 MB deserves a number rather than a spinner. */
async function fetchModel(url, onProgress) {
  const r = await fetch(url);
  if (!r.ok) throw Object.assign(new Error(`${url}: ${r.status}`), { status: r.status });

  const total = Number(r.headers.get('content-length')) || 0;
  if (!r.body || !total) return new Uint8Array(await r.arrayBuffer());

  const reader = r.body.getReader();
  const chunks = [];
  let seen = 0;
  for (;;) {
    const { done, value } = await reader.read();
    if (done) break;
    chunks.push(value);
    seen += value.length;
    onProgress?.(seen, total);
  }
  const out = new Uint8Array(seen);
  let at = 0;
  for (const c of chunks) { out.set(c, at); at += c.length; }
  return out;
}

/**
 * Load everything once. Repeat calls share the same promise, so two clicks
 * before the weights arrive do not start two 19 MB downloads.
 */
export function load(onProgress) {
  if (loadPromise) return loadPromise;
  state.status = 'loading';

  loadPromise = (async () => {
    const ort = await loadRuntime();
    meta = await fetchJSON(`${MODEL_DIR}g-doodle.meta.json`);
    prompts = await fetchJSON(`${MODEL_DIR}g-doodle.prompts.json`);
    const bytes = await fetchModel(`${MODEL_DIR}g-doodle.int8.onnx`, onProgress);
    state.bytes = bytes.length;
    session = await ort.InferenceSession.create(bytes, {
      executionProviders: ['wasm'],
      graphOptimizationLevel: 'all',
    });
    state.status = 'ready';
    return session;
  })().catch((err) => {
    loadPromise = null;
    /* A 404 is not a fault, it is the honest state of a model that has not
       finished training yet — and it reads very differently to a visitor. */
    state.status = err.status === 404 ? 'missing' : 'error';
    state.detail = err.message;
    throw err;
  });

  return loadPromise;
}

export const isReady = () => state.status === 'ready';
export const categories = () => meta?.categories ?? [];

/* --------------------------------------------------------------- prompt -- */

const FILLER = new Set(['narysuj', 'pokaz', 'chce', 'prosze', 'jakis', 'jakas',
                        'mi', 'a', 'draw', 'please', 'the', 'an']);

/** Must match `normalize()` in runtime/prompt.py, or the shipped table misses. */
export function normalize(text) {
  return String(text ?? '')
    .toLowerCase()
    .replace(/ł/g, 'l')
    .normalize('NFKD')
    .replace(/[̀-ͯ]/g, '')
    .replace(/[^a-z0-9 ]+/g, ' ')
    .split(/\s+/)
    .filter((w) => w && !FILLER.has(w))
    .join(' ');
}

const ratio = (a, b) => {
  /* Cheap similarity for typos: shared-character overlap, not edit distance.
     The alias table is small and this only has to rank candidates. */
  if (!a || !b) return 0;
  const short = a.length < b.length ? a : b;
  const long = a.length < b.length ? b : a;
  let hits = 0;
  const pool = long.split('');
  for (const ch of short) {
    const i = pool.indexOf(ch);
    if (i >= 0) { pool.splice(i, 1); hits += 1; }
  }
  return (2 * hits) / (a.length + b.length);
};

/**
 * Free text to one of the 345 categories, always carrying *how* it matched.
 *
 * The distinction matters more than the answer: a fuzzy hit should say what it
 * understood, and a miss should offer alternatives rather than quietly drawing
 * the nearest thing and letting someone believe the model tried.
 */
export function resolvePrompt(text) {
  const q = normalize(text);
  if (!q || !prompts) return { category: null, match: 'none', alternatives: [] };

  const hit = prompts.aliases[q];
  if (hit) return { category: hit, match: 'exact', label: prompts.labels[hit], alternatives: [] };

  for (const [miss, suggestions] of Object.entries(prompts.missing || {})) {
    if (normalize(miss) === q) {
      return { category: null, match: 'missing', alternatives: suggestions, asked: q };
    }
  }

  let best = null;
  for (const alias of Object.keys(prompts.aliases)) {
    if (alias.includes(q) || q.includes(alias)) {
      if (!best || alias.length > best.length) best = alias;
    }
  }
  if (best) {
    const cat = prompts.aliases[best];
    return { category: cat, match: 'contains', label: prompts.labels[cat], alternatives: [] };
  }

  const scored = Object.keys(prompts.aliases)
    .map((alias) => [ratio(q, alias), prompts.aliases[alias]])
    .sort((a, b) => b[0] - a[0]);
  const alts = [];
  for (const [, cat] of scored) {
    if (!alts.includes(cat)) alts.push(cat);
    if (alts.length === 4) break;
  }
  if (scored[0] && scored[0][0] >= 0.72) {
    const cat = scored[0][1];
    return { category: cat, match: 'fuzzy', label: prompts.labels[cat], score: scored[0][0],
             alternatives: alts.slice(1) };
  }
  return { category: null, match: 'none', alternatives: alts, asked: q };
}

export const labelOf = (category) => prompts?.labels?.[category] ?? category;

/* ------------------------------------------------------------ tokenizer -- */

/** Mirror of `bin_to_delta` in model/tokenizer.py. Drift here bends drawings. */
function binToDelta(bin) {
  const { fine, coarse_step: step } = meta.bins;
  const nCoarse = meta.layout.n_delta - (2 * fine + 1);
  const base = 2 * fine + 1;
  if (bin < base) return bin - fine;
  /* `n_delta` counts both signs, so half of the coarse bins are the positive
     side and the rest are the negative one — the same split the Python
     tokenizer makes with N_COARSE per side. */
  const rest = bin - base;
  const half = nCoarse / 2;
  const isNeg = rest >= half;
  const k = (isNeg ? rest - half : rest) + 1;
  const magnitude = fine + k * step - step / 2;
  return isNeg ? -magnitude : magnitude;
}

/* ----------------------------------------------------------- generation -- */

function sample(logits, temperature, topP, random) {
  const n = logits.length;
  const scaled = new Float32Array(n);
  for (let i = 0; i < n; i += 1) scaled[i] = logits[i] / Math.max(temperature, 1e-5);

  const order = Array.from({ length: n }, (_, i) => i).sort((a, b) => scaled[b] - scaled[a]);
  const top = scaled[order[0]];
  let sum = 0;
  const probs = new Float64Array(n);
  for (let i = 0; i < n; i += 1) {
    probs[i] = Math.exp(scaled[order[i]] - top);
    sum += probs[i];
  }

  let cumulative = 0;
  let keep = n;
  for (let i = 0; i < n; i += 1) {
    cumulative += probs[i] / sum;
    if (cumulative >= topP) { keep = i + 1; break; }
  }

  let mass = 0;
  for (let i = 0; i < keep; i += 1) mass += probs[i];
  let pick = random() * mass;
  for (let i = 0; i < keep; i += 1) {
    pick -= probs[i];
    if (pick <= 0) return order[i];
  }
  return order[0];
}

function emptyCache(ort) {
  /* n_kv_head, not n_head: grouped-query attention means the graph returns a
     cache KVH heads wide (2 here against 6 query heads), and that narrowing is
     the whole reason it was added before training — it is what takes a
     400-token drawing from ~27 s toward something worth watching. Getting this
     wrong surfaces as an opaque ONNX dimension error on the first step.
     Falling back to n_head keeps older exports loadable. */
  const kvHeads = meta.n_kv_head ?? meta.n_head;
  const dims = [meta.n_layer, 1, kvHeads, 0, meta.head_dim];
  const empty = new Float32Array(0);
  return [new ort.Tensor('float32', empty, dims), new ort.Tensor('float32', empty, dims)];
}

/**
 * Draw one sketch, reporting points as they are produced.
 *
 * `onPoint(x, y, penDown)` fires per pen movement so the caller can paint the
 * stroke as it happens. Watching it draw is the feature, so nothing here waits
 * for the whole sequence before showing anything.
 */
export async function draw(category, {
  onPoint, onDone, signal, temperature = 0.9, topP = 0.9, maxTokens = 460, seed,
} = {}) {
  if (!session) throw new Error('model nie jest wczytany');

  const ort = window.ort;
  const catToken = meta.layout.cat_base + meta.categories.indexOf(category);
  if (catToken < meta.layout.cat_base) throw new Error(`nieznana kategoria: ${category}`);

  let rngState = (seed ?? Math.floor(Math.random() * 2 ** 31)) >>> 0;
  const random = () => {
    rngState = (rngState * 1664525 + 1013904223) >>> 0;
    return rngState / 2 ** 32;
  };

  let [pastK, pastV] = emptyCache(ort);
  let logits = null;
  let position = 0;

  const step = async (token) => {
    const out = await session.run({
      input_ids: new ort.Tensor('int64', BigInt64Array.from([BigInt(token)]), [1, 1]),
      positions: new ort.Tensor('int64', BigInt64Array.from([BigInt(position)]), [1]),
      past_k: pastK,
      past_v: pastV,
    });
    pastK = out.present_k;
    pastV = out.present_v;
    logits = out.logits.data;
    position += 1;
  };

  await step(meta.tokens.BOS);
  await step(catToken);

  const { dx_base: dxBase, dy_base: dyBase } = meta.layout;
  let x = 0;
  let y = 0;
  let penDown = false;
  let pendingDx = null;
  const points = [];

  for (let i = 0; i < maxTokens; i += 1) {
    if (signal?.aborted) break;
    const token = sample(logits, temperature, topP, random);
    if (token === meta.tokens.EOS) break;

    if (token === meta.tokens.PEN_UP) {
      penDown = false;
      pendingDx = null;
    } else if (token >= dyBase) {
      if (pendingDx !== null) {
        x += pendingDx;
        y += binToDelta(token - dyBase);
        pendingDx = null;
        points.push([x, y, penDown]);
        onPoint?.(x, y, penDown);
        penDown = true;
      }
    } else if (token >= dxBase) {
      pendingDx = binToDelta(token - dxBase);
    }

    if (position >= meta.block_size - 1) break;
    await step(token);
  }

  onDone?.(points);
  return points;
}

/* ------------------------------------------------------------ rendering -- */

/**
 * Paint points onto a canvas, rescaling as the drawing grows.
 *
 * The bounding box is unknown until the last stroke, so every frame redraws the
 * whole path against the current box. At a few hundred points that is far
 * cheaper than it sounds, and it avoids the alternative — guessing a scale up
 * front and having the sketch walk off the edge.
 */
export function painter(canvas, { colour, width = 3, padding = 0.1 } = {}) {
  const ctx = canvas.getContext('2d');
  const points = [];
  let box = null;
  let frame = null;

  const paint = () => {
    frame = null;
    const dpr = window.devicePixelRatio || 1;
    const w = canvas.clientWidth || 320;
    const h = canvas.clientHeight || 320;
    if (canvas.width !== w * dpr || canvas.height !== h * dpr) {
      canvas.width = w * dpr;
      canvas.height = h * dpr;
    }
    ctx.setTransform(dpr, 0, 0, dpr, 0, 0);
    ctx.clearRect(0, 0, w, h);
    if (!box || points.length < 2) return;

    const span = Math.max(box.maxX - box.minX, box.maxY - box.minY, 1);
    const pad = Math.min(w, h) * padding;
    const scale = (Math.min(w, h) - 2 * pad) / span;
    const offX = (w - (box.maxX - box.minX) * scale) / 2;
    const offY = (h - (box.maxY - box.minY) * scale) / 2;

    ctx.strokeStyle = colour
      || getComputedStyle(canvas).getPropertyValue('color').trim() || '#111';
    ctx.lineWidth = width;
    ctx.lineCap = 'round';
    ctx.lineJoin = 'round';
    ctx.beginPath();
    for (const [px, py, down] of points) {
      const cx = (px - box.minX) * scale + offX;
      const cy = (py - box.minY) * scale + offY;
      if (down) ctx.lineTo(cx, cy); else ctx.moveTo(cx, cy);
    }
    ctx.stroke();
  };

  return {
    add(x, y, penDown) {
      points.push([x, y, penDown]);
      box = box
        ? { minX: Math.min(box.minX, x), maxX: Math.max(box.maxX, x),
            minY: Math.min(box.minY, y), maxY: Math.max(box.maxY, y) }
        : { minX: x, maxX: x, minY: y, maxY: y };
      if (frame === null) frame = requestAnimationFrame(paint);
    },
    clear() {
      points.length = 0;
      box = null;
      if (frame !== null) { cancelAnimationFrame(frame); frame = null; }
      paint();
    },
    repaint: paint,
    get count() { return points.length; },
  };
}
