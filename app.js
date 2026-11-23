/* GreenKey: green-screen media -> transparent WebM (VP9/VP8 alpha) or PNG. Fully local, no server, no uploads.
 *
 * Matte: colour-difference key + unpremultiply (see README "How the key works").
 *   d(C) = C[dom] - max(C[o1], C[o2])         (dom = key colour's strongest channel, e.g. G for green)
 *   a0   = 1 - clamp(d(C) * strength / d(K))  (linear: a semi-transparent band keeps its real alpha)
 *   a    = clamp((a0 - clip) / (1 - 2 clip)) with clip = 0.3 * (1 - softness)  (snaps noise at 0 and 1, keeps 0.5)
 *   F    = (C - (1 - a) K) / a                (unpremultiply: removes the green that shows through)
 *   F[dom] = min(F[dom], max(F[o1], F[o2]) + (1 - spill) * 0.3)   (despill)
 * Decode: mp4/mov via mp4box.js, webm via a small EBML demuxer, both into WebCodecs VideoDecoder (every frame, source
 * timestamps kept). GIF via ImageDecoder. Encode: two WebCodecs VideoEncoders (colour + alpha-as-luma) muxed as
 * WebM BlockAdditional alpha by webm-muxer (patched, see vendor/README.md). Audio: decodeAudioData -> Opus.
 */
'use strict';
(() => {
const $ = (id) => document.getElementById(id);
const DEFAULTS = { strength: 105, spill: 100, soft: 70 };
const state = {
  file: null, kind: null,           // 'image' | 'gif' | 'video'
  w: 0, h: 0,
  bitmap: null,                     // image
  gifDec: null, gifFrames: [],      // gif: [{ts, dur}] (µs)
  video: null, url: null,           // video preview element
  key: [0, 177 / 255, 64 / 255], keyAuto: true,
  picking: false, playing: false, gifIndex: 0, gifTimer: 0,
  exporting: false,
};
window.GK = state; // test hook (read-only use)

// ---------------- WebGL2 keyer ----------------
const glCanvas = document.createElement('canvas');
const gl = glCanvas.getContext('webgl2', { premultipliedAlpha: false, alpha: true, preserveDrawingBuffer: true, antialias: false });
const VS = `#version 300 es
in vec2 p; uniform bool u_flip; out vec2 v_uv;
void main(){ v_uv = vec2(p.x * 0.5 + 0.5, u_flip ? p.y * 0.5 + 0.5 : 0.5 - p.y * 0.5); gl_Position = vec4(p, 0.0, 1.0); }`;
const FS = `#version 300 es
precision highp float;
uniform sampler2D u_src; uniform vec3 u_key, u_dom, u_o1, u_o2;
uniform float u_strength, u_clip, u_spill, u_orig;
in vec2 v_uv; out vec4 o;
float diffc(vec3 c){ return dot(c, u_dom) - max(dot(c, u_o1), dot(c, u_o2)); }
void main(){
  vec4 s = texture(u_src, v_uv);
  if (u_orig > 0.5) { o = s; return; }
  vec3 c = s.rgb;
  float dK = max(diffc(u_key), 1e-3);
  float a0 = 1.0 - clamp(diffc(c) * u_strength / dK, 0.0, 1.0);
  float a = clamp((a0 - u_clip) / max(1.0 - 2.0 * u_clip, 1e-3), 0.0, 1.0);
  vec3 f = c;
  if (a > 0.003) f = clamp((c - (1.0 - a) * u_key) / a, 0.0, 1.0);
  float dom = dot(f, u_dom);
  float lim = max(dot(f, u_o1), dot(f, u_o2)) + (1.0 - u_spill) * 0.3;
  f += u_dom * (min(dom, lim) - dom);
  a *= s.a;
  o = vec4(a > 0.0 ? f : vec3(0.0), a);
}`;
let prog, tex, fbo, fboTex, U = {};
function initGL() {
  if (!gl) throw new Error('WebGL2 is not available in this browser.');
  const sh = (type, src) => { const s = gl.createShader(type); gl.shaderSource(s, src); gl.compileShader(s);
    if (!gl.getShaderParameter(s, gl.COMPILE_STATUS)) throw new Error(gl.getShaderInfoLog(s)); return s; };
  prog = gl.createProgram();
  gl.attachShader(prog, sh(gl.VERTEX_SHADER, VS)); gl.attachShader(prog, sh(gl.FRAGMENT_SHADER, FS));
  gl.linkProgram(prog);
  if (!gl.getProgramParameter(prog, gl.LINK_STATUS)) throw new Error(gl.getProgramInfoLog(prog));
  gl.useProgram(prog);
  for (const n of ['u_src', 'u_key', 'u_dom', 'u_o1', 'u_o2', 'u_strength', 'u_clip', 'u_spill', 'u_orig', 'u_flip']) U[n] = gl.getUniformLocation(prog, n);
  const buf = gl.createBuffer(); gl.bindBuffer(gl.ARRAY_BUFFER, buf);
  gl.bufferData(gl.ARRAY_BUFFER, new Float32Array([-1, -1, 3, -1, -1, 3]), gl.STATIC_DRAW);
  const loc = gl.getAttribLocation(prog, 'p'); gl.enableVertexAttribArray(loc); gl.vertexAttribPointer(loc, 2, gl.FLOAT, false, 0, 0);
  tex = gl.createTexture(); gl.bindTexture(gl.TEXTURE_2D, tex);
  for (const [k, v] of [[gl.TEXTURE_MIN_FILTER, gl.NEAREST], [gl.TEXTURE_MAG_FILTER, gl.NEAREST], [gl.TEXTURE_WRAP_S, gl.CLAMP_TO_EDGE], [gl.TEXTURE_WRAP_T, gl.CLAMP_TO_EDGE]]) gl.texParameteri(gl.TEXTURE_2D, k, v);
  gl.pixelStorei(gl.UNPACK_PREMULTIPLY_ALPHA_WEBGL, false);
  gl.pixelStorei(gl.UNPACK_FLIP_Y_WEBGL, false);
  gl.uniform1i(U.u_src, 0);
}
function sizeGL(w, h) {
  glCanvas.width = w; glCanvas.height = h;
  if (fbo) { gl.deleteFramebuffer(fbo); gl.deleteTexture(fboTex); }
  fboTex = gl.createTexture(); gl.bindTexture(gl.TEXTURE_2D, fboTex);
  gl.texImage2D(gl.TEXTURE_2D, 0, gl.RGBA8, w, h, 0, gl.RGBA, gl.UNSIGNED_BYTE, null);
  fbo = gl.createFramebuffer(); gl.bindFramebuffer(gl.FRAMEBUFFER, fbo);
  gl.framebufferTexture2D(gl.FRAMEBUFFER, gl.COLOR_ATTACHMENT0, gl.TEXTURE_2D, fboTex, 0);
  gl.bindFramebuffer(gl.FRAMEBUFFER, null);
  gl.bindTexture(gl.TEXTURE_2D, tex);
}
function params() {
  const k = state.key;
  const dom = k.indexOf(Math.max(...k));
  const others = [0, 1, 2].filter((i) => i !== dom);
  const one = (i) => [0, 1, 2].map((j) => (j === i ? 1 : 0));
  return { key: k, dom: one(dom), o1: one(others[0]), o2: one(others[1]),
    strength: +$('strength').value / 100, spill: +$('spill').value / 100, clip: 0.3 * (1 - +$('soft').value / 100) };
}
/** Key `source` (VideoFrame | HTMLVideoElement | ImageBitmap | canvas). toFbo -> returns RGBA Uint8Array, top row first. */
function keyFrame(source, { toFbo = false, orig = false } = {}) {
  const p = params();
  gl.bindTexture(gl.TEXTURE_2D, tex);
  gl.texImage2D(gl.TEXTURE_2D, 0, gl.RGBA, gl.RGBA, gl.UNSIGNED_BYTE, source);
  gl.uniform3fv(U.u_key, p.key); gl.uniform3fv(U.u_dom, p.dom); gl.uniform3fv(U.u_o1, p.o1); gl.uniform3fv(U.u_o2, p.o2);
  gl.uniform1f(U.u_strength, p.strength); gl.uniform1f(U.u_clip, p.clip); gl.uniform1f(U.u_spill, p.spill);
  gl.uniform1f(U.u_orig, orig ? 1 : 0); gl.uniform1i(U.u_flip, toFbo ? 1 : 0);
  gl.bindFramebuffer(gl.FRAMEBUFFER, toFbo ? fbo : null);
  gl.viewport(0, 0, state.w, state.h);
  gl.disable(gl.BLEND);
  gl.drawArrays(gl.TRIANGLES, 0, 3);
  if (!toFbo) return null;
  const px = new Uint8Array(state.w * state.h * 4);
  gl.readPixels(0, 0, state.w, state.h, gl.RGBA, gl.UNSIGNED_BYTE, px);
  gl.bindFramebuffer(gl.FRAMEBUFFER, null);
  return px;
}

// ---------------- preview ----------------
const views = [$('viewChecker'), $('viewDark')];
const vctx = views.map((c) => c.getContext('2d'));
const origCanvas = $('origCanvas');
const octx = origCanvas.getContext('2d', { willReadFrequently: true });
function currentSource() {
  if (state.kind === 'image') return Promise.resolve(state.bitmap);
  if (state.kind === 'video') return Promise.resolve(state.video);
  if (state.kind === 'gif') return state.gifDec.decode({ frameIndex: state.gifIndex }).then((r) => r.image);
  return Promise.resolve(null);
}
let renderBusy = false, renderAgain = false;
async function render() {
  if (!state.kind || state.exporting) return;
  if (renderBusy) { renderAgain = true; return; }
  renderBusy = true;
  try {
    const src = await currentSource();
    if (src) {
      keyFrame(src);
      for (const c of vctx) { c.clearRect(0, 0, state.w, state.h); c.drawImage(glCanvas, 0, 0); }
      if (!$('origFig').hidden || state.picking) octx.drawImage(src, 0, 0, state.w, state.h);
      if (src instanceof VideoFrame) src.close();
    }
  } finally {
    renderBusy = false;
    if (renderAgain) { renderAgain = false; render(); }
  }
  updateTime();
}

// ---------------- key colour ----------------
function setKey(rgb, auto) {
  state.key = rgb; state.keyAuto = auto;
  const hex = '#' + rgb.map((v) => Math.round(v * 255).toString(16).padStart(2, '0')).join('');
  $('keySwatch').style.background = hex;
  $('keyHex').textContent = hex + (auto ? ' (auto)' : ' (picked)');
  render();
}
async function autoKey() {
  const src = await currentSource();
  const c = document.createElement('canvas'); c.width = state.w; c.height = state.h;
  const x = c.getContext('2d', { willReadFrequently: true });
  x.drawImage(src, 0, 0, state.w, state.h);
  if (src instanceof VideoFrame) src.close();
  const b = Math.max(2, Math.round(Math.min(state.w, state.h) * 0.01));
  const ch = [[], [], []];
  const take = (d) => { for (let i = 0; i < d.length; i += 4) if (d[i + 3] > 128) { ch[0].push(d[i]); ch[1].push(d[i + 1]); ch[2].push(d[i + 2]); } };
  take(x.getImageData(0, 0, state.w, b).data); take(x.getImageData(0, state.h - b, state.w, b).data);
  take(x.getImageData(0, 0, b, state.h).data); take(x.getImageData(state.w - b, 0, b, state.h).data);
  if (!ch[0].length) return;
  const med = (a) => { a.sort((p, q) => p - q); return a[a.length >> 1] / 255; };
  setKey(ch.map(med), true);
}
function pickAt(ev) {
  const r = ev.target.getBoundingClientRect();
  const x = Math.floor((ev.clientX - r.left) / r.width * state.w), y = Math.floor((ev.clientY - r.top) / r.height * state.h);
  const r2 = 2, d = octx.getImageData(Math.max(0, x - r2), Math.max(0, y - r2), r2 * 2 + 1, r2 * 2 + 1).data;
  const s = [0, 0, 0]; let n = 0;
  for (let i = 0; i < d.length; i += 4) { s[0] += d[i]; s[1] += d[i + 1]; s[2] += d[i + 2]; n++; }
  setKey(s.map((v) => v / n / 255), false);
  setPicking(false);
}
function setPicking(on) {
  state.picking = on; document.body.classList.toggle('picking', on);
  if (on) render();
}

// ---------------- loading ----------------
function status(msg, err = false) { const s = $('status'); s.textContent = msg; s.classList.toggle('err', err); }
function stopPlayback() {
  state.playing = false; clearTimeout(state.gifTimer);
  if (state.video) state.video.pause();
  $('playBtn').textContent = 'Play';
}
function unload() {
  stopPlayback();
  if (state.video) { state.video.removeAttribute('src'); state.video.load(); state.video = null; }
  if (state.url) URL.revokeObjectURL(state.url);
  if (state.gifDec) state.gifDec.close();
  if (state.bitmap) state.bitmap.close?.();
  Object.assign(state, { kind: null, bitmap: null, gifDec: null, gifFrames: [], url: null, gifIndex: 0 });
}
function setSize(w, h) {
  state.w = w; state.h = h; sizeGL(w, h);
  for (const c of [...views, origCanvas]) { c.width = w; c.height = h; }
}
function kindOf(file) {
  const n = file.name.toLowerCase(), t = file.type;
  if (t === 'image/gif' || n.endsWith('.gif')) return 'gif';
  if (t.startsWith('image/') || /\.(png|jpe?g|webp)$/.test(n)) return 'image';
  if (t.startsWith('video/') || /\.(mp4|m4v|mov|webm|mkv)$/.test(n)) return 'video';
  return null;
}
async function loadFile(file) {
  unload();
  document.body.dataset.state = 'loading';
  status('Loading ' + file.name + ' ...');
  const kind = kindOf(file);
  if (!kind) { status('Unsupported file type: ' + file.name, true); document.body.dataset.state = 'empty'; return; }
  state.file = file; state.kind = kind;
  $('fileName').textContent = file.name;
  $('drop').hidden = true; $('work').hidden = false;
  try {
    if (kind === 'image') {
      state.bitmap = await createImageBitmap(file, { premultiplyAlpha: 'none', colorSpaceConversion: 'none' });
      setSize(state.bitmap.width, state.bitmap.height);
    } else if (kind === 'gif') {
      if (!('ImageDecoder' in window)) throw new Error('This browser has no ImageDecoder (use Chrome or Edge).');
      state.gifDec = new ImageDecoder({ data: await file.arrayBuffer(), type: 'image/gif' });
      await state.gifDec.tracks.ready; await state.gifDec.completed;
      const n = state.gifDec.tracks.selectedTrack.frameCount;
      for (let i = 0; i < n; i++) {
        const { image } = await state.gifDec.decode({ frameIndex: i });
        if (i === 0) setSize(image.displayWidth, image.displayHeight);
        state.gifFrames.push({ ts: image.timestamp, dur: image.duration || 100000 });
        image.close();
      }
    } else {
      state.url = URL.createObjectURL(file);
      const v = document.createElement('video');
      v.muted = false; v.playsInline = true; v.preload = 'auto'; v.loop = true; v.src = state.url;
      await new Promise((res, rej) => { v.onloadeddata = res; v.onerror = () => rej(new Error('The browser cannot play this video for preview (codec?).')); });
      state.video = v; setSize(v.videoWidth, v.videoHeight);
      v.addEventListener('seeked', () => render());
      const tick = () => { if (state.video !== v) return; render(); v.requestVideoFrameCallback(tick); };
      v.requestVideoFrameCallback(tick);
    }
    $('transport').hidden = kind === 'image';
    $('exportBtn').textContent = kind === 'image' ? 'Export PNG' : 'Export WebM (alpha)';
    await autoKey();
    await render();
    status(`${state.w}x${state.h}` + (kind === 'gif' ? `, ${state.gifFrames.length} frames` : '') +
      (kind === 'video' ? `, ${state.video.duration.toFixed(2)} s` : ''));
    document.body.dataset.state = 'ready';
  } catch (e) {
    console.error(e); status(e.message || String(e), true); document.body.dataset.state = 'error';
  }
}

// ---------------- transport ----------------
function duration() {
  if (state.kind === 'video') return state.video.duration || 0;
  if (state.kind === 'gif') { const f = state.gifFrames.at(-1); return f ? (f.ts + f.dur) / 1e6 : 0; }
  return 0;
}
function now() {
  if (state.kind === 'video') return state.video.currentTime;
  if (state.kind === 'gif') return (state.gifFrames[state.gifIndex]?.ts || 0) / 1e6;
  return 0;
}
function updateTime() {
  const d = duration();
  $('timeLabel').textContent = `${now().toFixed(2)} / ${d.toFixed(2)} s`;
  if (!scrubbing && d > 0) $('scrub').value = Math.round(now() / d * 1000);
}
let scrubbing = false;
function gifStep() {
  if (!state.playing) return;
  const f = state.gifFrames[state.gifIndex];
  state.gifTimer = setTimeout(() => { state.gifIndex = (state.gifIndex + 1) % state.gifFrames.length; render(); gifStep(); }, f.dur / 1000);
}
function togglePlay() {
  if (state.kind === 'image') return;
  if (state.playing) { stopPlayback(); return; }
  state.playing = true; $('playBtn').textContent = 'Pause';
  if (state.kind === 'video') state.video.play(); else gifStep();
}
function seekFraction(f) {
  const t = f * duration();
  if (state.kind === 'video') state.video.currentTime = Math.min(t, state.video.duration - 0.001);
  else if (state.kind === 'gif') {
    let i = state.gifFrames.findIndex((g) => g.ts / 1e6 + g.dur / 1e6 > t);
    state.gifIndex = i < 0 ? state.gifFrames.length - 1 : i; render();
  }
}

// ---------------- demux ----------------
function demuxMp4(buf) {
  return new Promise((resolve, reject) => {
    const f = MP4Box.createFile();
    let track = null; const samples = [];
    f.onError = (e) => reject(new Error('MP4 parse error: ' + e));
    f.onReady = (info) => {
      track = info.videoTracks[0];
      if (!track) { reject(new Error('No video track found.')); return; }
      f.setExtractionOptions(track.id, null, { nbSamples: 1e9 });
      f.start();
    };
    f.onSamples = (id, user, s) => { for (const x of s) samples.push(x); };
    buf.fileStart = 0; f.appendBuffer(buf); f.flush();
    if (!track) { reject(new Error('Could not read this MP4/MOV.')); return; }
    const trak = f.getTrackById(track.id);
    let description;
    for (const e of trak.mdia.minf.stbl.stsd.entries) {
      const box = e.avcC || e.hvcC || e.vpcC || e.av1C;
      if (box) { const DS = window.DataStream || MP4Box.DataStream; const ds = new DS(undefined, 0, DS.BIG_ENDIAN); box.write(ds); description = new Uint8Array(ds.buffer, 8); break; }
    }
    resolve({
      config: { codec: track.codec.startsWith('vp08') ? 'vp8' : track.codec, codedWidth: track.video.width, codedHeight: track.video.height, description },
      chunks: samples.map((s) => ({ type: s.is_sync ? 'key' : 'delta', timestamp: Math.round(s.cts * 1e6 / s.timescale), duration: Math.round(s.duration * 1e6 / s.timescale), data: s.data })),
    });
  });
}
/** Minimal WebM/Matroska demuxer: first video track's frames (SimpleBlock / BlockGroup, no lacing). */
function demuxWebm(buf) {
  const u = new Uint8Array(buf); const N = u.length;
  const vint = (p, keepMarker) => { const b = u[p]; let len = 1, m = 0x80; while (len <= 8 && !(b & m)) { len++; m >>= 1; }
    let v = keepMarker ? b : b & (m - 1); let allOnes = (b & (m - 1)) === m - 1;
    for (let i = 1; i < len; i++) { v = v * 256 + u[p + i]; if (u[p + i] !== 255) allOnes = false; }
    return { v, len, unknown: !keepMarker && allOnes }; };
  const uint = (p, n) => { let v = 0; for (let i = 0; i < n; i++) v = v * 256 + u[p + i]; return v; };
  const str = (p, n) => String.fromCharCode(...u.subarray(p, p + n)).replace(/\0+$/, '');
  const MASTER = new Set([0x18538067, 0x1654AE6B, 0xAE, 0xE0, 0x1F43B675, 0xA0, 0x1549A966]);
  let scale = 1e6, vTrack = null; const tracks = []; let clusterTs = 0; const blocks = [];
  let cur = null;
  const parse = (start, end) => {
    let p = start;
    while (p < end && p < N) {
      const id = vint(p, true); p += id.len; const sz = vint(p, false); p += sz.len;
      const size = sz.unknown ? end - p : sz.v; const dEnd = Math.min(p + size, end);
      switch (id.v) {
        case 0xAE: cur = {}; tracks.push(cur); parse(p, dEnd); break;
        case 0xD7: if (cur) cur.num = uint(p, size); break;
        case 0x83: if (cur) cur.type = uint(p, size); break;
        case 0x86: if (cur) cur.codec = str(p, size); break;
        case 0x63A2: if (cur) cur.priv = u.slice(p, p + size); break;
        case 0xB0: if (cur) cur.w = uint(p, size); break;
        case 0xBA: if (cur) cur.h = uint(p, size); break;
        case 0x23E383: if (cur) cur.defDur = uint(p, size); break;
        case 0x2AD7B1: scale = uint(p, size); break;
        case 0xE7: clusterTs = uint(p, size); break;
        case 0xA3: case 0xA1: {
          const tn = vint(p, false); const rel = (u[p + tn.len] << 8 | u[p + tn.len + 1]) << 16 >> 16; const flags = u[p + tn.len + 2];
          const b = { track: tn.v, ts: clusterTs + rel, key: id.v === 0xA3 ? !!(flags & 0x80) : true, data: u.subarray(p + tn.len + 3, dEnd) };
          if (id.v === 0xA1 && blocks.group) blocks.group.block = b; else blocks.push(b);
          break;
        }
        case 0xA0: { const g = { block: null, ref: false }; blocks.group = g; parse(p, dEnd); blocks.group = null; if (g.block) { g.block.key = !g.ref; blocks.push(g.block); } break; }
        case 0xFB: if (blocks.group) blocks.group.ref = true; break;
        default: if (MASTER.has(id.v)) parse(p, dEnd);
      }
      if (sz.unknown && MASTER.has(id.v)) return; // unknown-size master parsed to the end
      p = dEnd;
    }
  };
  parse(0, N);
  vTrack = tracks.find((t) => t.type === 1);
  if (!vTrack) throw new Error('No video track found in WebM.');
  const codec = { V_VP8: 'vp8', V_VP9: 'vp09.00.10.08', V_AV1: 'av01.0.08M.08' }[vTrack.codec];
  if (!codec) throw new Error('Unsupported WebM video codec: ' + vTrack.codec);
  const vb = blocks.filter((b) => b.track === vTrack.num).map((b) => ({ ...b, us: Math.round(b.ts * scale / 1000) }));
  const sorted = vb.map((b) => b.us).sort((a, b) => a - b);
  const steps = sorted.slice(1).map((t, i) => t - sorted[i]).filter((d) => d > 0).sort((a, b) => a - b);
  const typical = vTrack.defDur ? Math.round(vTrack.defDur / 1000) : (steps[steps.length >> 1] || 33333);
  const next = new Map(sorted.map((t, i) => [t, i + 1 < sorted.length ? sorted[i + 1] - t : typical]));
  return {
    config: { codec, codedWidth: vTrack.w, codedHeight: vTrack.h, description: vTrack.codec === 'V_AV1' ? vTrack.priv : undefined },
    chunks: vb.map((b) => ({ type: b.key ? 'key' : 'delta', timestamp: b.us, duration: next.get(b.us), data: b.data })),
  };
}

// ---------------- export ----------------
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));
// Chrome/Edge WebCodecs refuse alpha:'keep' ("Alpha encoding is not currently supported", measured on Chrome 157 /
// Edge 158), so alpha is done the way WebM itself stores it: TWO VP9/VP8 streams. Stream 1 = colour; stream 2 = the
// alpha plane as the luma (Y) of an I420 frame. Each alpha chunk is written into the colour block's BlockAdditional
// (BlockAddID 1), which is exactly what libvpx / Chrome / OBS decode as VP9-alpha WebM.
async function pickEncoderConfig(w, h, fps) {
  const bitrate = Math.round(Math.min(40e6, Math.max(2e6, w * h * fps * 0.25)));
  for (const codec of ['vp09.00.10.08', 'vp8']) {
    const cfg = { codec, width: w, height: h, bitrate, framerate: fps, latencyMode: 'quality' };
    try { const r = await VideoEncoder.isConfigSupported(cfg); if (r.supported) return { cfg, mux: codec === 'vp8' ? 'V_VP8' : 'V_VP9' }; } catch { /* try next */ }
  }
  throw new Error('This browser cannot encode VP9/VP8 (use Chrome or Edge).');
}
async function decodeAudio(file) {
  try {
    const ac = new OfflineAudioContext(2, 48000, 48000);
    const ab = await ac.decodeAudioData(await file.arrayBuffer());
    return ab.length ? ab : null;
  } catch { return null; } // no audio track / unsupported
}
/** frames: async iterator of {source, timestamp, duration} (µs). Returns Blob. */
async function encodeWebm(frameIter, total, fps, audio) {
  const { cfg, mux } = await pickEncoderConfig(state.w, state.h, fps);
  const target = new WebMMuxer.ArrayBufferTarget();
  const muxOpts = { target, firstTimestampBehavior: 'offset',
    video: { codec: mux, width: state.w, height: state.h, alpha: true, frameRate: fps } };
  if (audio) muxOpts.audio = { codec: 'A_OPUS', sampleRate: 48000, numberOfChannels: audio.numberOfChannels };
  const muxer = new WebMMuxer.Muxer(muxOpts);
  let encErr = null; const onErr = (e) => { encErr = e; };
  const colour = new Map(), alpha = new Map(); // timestamp -> {chunk, meta} / Uint8Array
  const pair = (ts) => {
    if (!colour.has(ts) || !alpha.has(ts)) return;
    const { chunk, meta } = colour.get(ts); colour.delete(ts);
    muxer.addVideoChunk(chunk, { ...(meta || {}), alphaSideData: alpha.get(ts) }); alpha.delete(ts);
  };
  const enc = new VideoEncoder({ output: (c, m) => { colour.set(c.timestamp, { chunk: c, meta: m }); pair(c.timestamp); }, error: onErr });
  const encA = new VideoEncoder({ output: (c) => { const b = new Uint8Array(c.byteLength); c.copyTo(b); alpha.set(c.timestamp, b); pair(c.timestamp); }, error: onErr });
  enc.configure(cfg);
  encA.configure({ ...cfg, bitrate: Math.round(cfg.bitrate / 2) });
  const w = state.w, h = state.h, cw = (w + 1) >> 1, chh = (h + 1) >> 1;
  const yuvA = new Uint8Array(w * h + 2 * cw * chh); yuvA.fill(128, w * h);
  let i = 0, firstTs = null, endUs = 0; const gop = Math.max(1, Math.round(fps * 2));
  for await (const fr of frameIter) {
    if (encErr) throw encErr;
    const px = keyFrame(fr.source, { toFbo: true });
    if (fr.source instanceof VideoFrame) fr.source.close();
    for (let p = 0, q = 3; p < w * h; p++, q += 4) yuvA[p] = px[q];
    const meta = { timestamp: fr.timestamp, duration: fr.duration };
    const vf = new VideoFrame(px, { format: 'RGBA', codedWidth: w, codedHeight: h, ...meta });
    const va = new VideoFrame(yuvA, { format: 'I420', codedWidth: w, codedHeight: h, ...meta });
    const kf = { keyFrame: i % gop === 0 };
    enc.encode(vf, kf); encA.encode(va, kf); vf.close(); va.close();
    if (firstTs === null) firstTs = fr.timestamp;
    endUs = Math.max(endUs, fr.timestamp + (fr.duration || 0));
    i++;
    $('progress').value = i / total * (audio ? 0.95 : 1); status(`Encoding frame ${i} / ${total}`);
    while (enc.encodeQueueSize > 3 || encA.encodeQueueSize > 3) await sleep(2);
  }
  await Promise.all([enc.flush(), encA.flush()]); enc.close(); encA.close();
  if (encErr) throw encErr;
  if (colour.size || alpha.size) throw new Error(`Alpha/colour streams out of step (${colour.size}/${alpha.size} unpaired).`);
  muxer.endTimeMs = (endUs - (firstTs || 0)) / 1000;
  if (audio) await encodeAudio(audio, muxer);
  muxer.finalize();
  state.lastExport = { frames: i, codec: cfg.codec, audio: !!audio };
  return new Blob([target.buffer], { type: 'video/webm' });
}
async function encodeAudio(ab, muxer) {
  status('Encoding audio (Opus) ...');
  let err = null;
  const ch = ab.numberOfChannels;
  const enc = new AudioEncoder({ output: (c, m) => muxer.addAudioChunk(c, m), error: (e) => { err = e; } });
  enc.configure({ codec: 'opus', sampleRate: 48000, numberOfChannels: ch, bitrate: 160000 });
  const block = 960; const chans = [...Array(ch)].map((_, c) => ab.getChannelData(c));
  for (let s = 0; s < ab.length; s += block) {
    const n = Math.min(block, ab.length - s); const data = new Float32Array(n * ch);
    for (let c = 0; c < ch; c++) data.set(chans[c].subarray(s, s + n), c * n);
    const ad = new AudioData({ format: 'f32-planar', sampleRate: 48000, numberOfFrames: n, numberOfChannels: ch, timestamp: Math.round(s / 48000 * 1e6), data });
    enc.encode(ad); ad.close();
    while (enc.encodeQueueSize > 16) await sleep(1);
  }
  await enc.flush(); enc.close();
  if (err) throw err;
}
async function* videoFrames(dem) {
  const out = []; let decErr = null;
  const dec = new VideoDecoder({ output: (f) => out.push(f), error: (e) => { decErr = e; } });
  const cfg = { ...dem.config, hardwareAcceleration: 'prefer-software' };
  if (!(await VideoDecoder.isConfigSupported(cfg)).supported) delete cfg.hardwareAcceleration;
  dec.configure(cfg);
  const durOf = new Map(dem.chunks.map((c) => [c.timestamp, c.duration]));
  let fed = 0;
  const emit = function* () { while (out.length) { const f = out.shift(); yield { source: f, timestamp: f.timestamp, duration: durOf.get(f.timestamp) ?? f.duration ?? 0 }; } };
  while (fed < dem.chunks.length) {
    if (decErr) throw decErr;
    if (dec.decodeQueueSize < 8 && out.length < 4) {
      const c = dem.chunks[fed++];
      dec.decode(new EncodedVideoChunk({ type: c.type, timestamp: c.timestamp, duration: c.duration, data: c.data }));
    } else if (out.length) { yield* emit(); } else { await sleep(1); }
  }
  const fl = dec.flush();
  while (true) { yield* emit(); if (await Promise.race([fl.then(() => true), sleep(5).then(() => false)])) break; }
  yield* emit();
  dec.close();
  if (decErr) throw decErr;
}
async function* gifFrameIter() {
  for (let i = 0; i < state.gifFrames.length; i++) {
    const { image } = await state.gifDec.decode({ frameIndex: i });
    yield { source: image, timestamp: state.gifFrames[i].ts, duration: state.gifFrames[i].dur };
  }
}
// --- PNG writer (exact straight-alpha RGBA, no canvas premultiply round-trip) ---
const CRC = (() => { const t = new Uint32Array(256); for (let n = 0; n < 256; n++) { let c = n; for (let k = 0; k < 8; k++) c = c & 1 ? 0xEDB88320 ^ (c >>> 1) : c >>> 1; t[n] = c >>> 0; } return t; })();
function crc32(bytes) { let c = 0xFFFFFFFF; for (let i = 0; i < bytes.length; i++) c = CRC[(c ^ bytes[i]) & 255] ^ (c >>> 8); return (c ^ 0xFFFFFFFF) >>> 0; }
function pngChunk(type, data) {
  const out = new Uint8Array(12 + data.length); const dv = new DataView(out.buffer);
  dv.setUint32(0, data.length); for (let i = 0; i < 4; i++) out[4 + i] = type.charCodeAt(i);
  out.set(data, 8); dv.setUint32(8 + data.length, crc32(out.subarray(4, 8 + data.length))); return out;
}
async function encodePng(px, w, h) {
  const raw = new Uint8Array(h * (w * 4 + 1));
  for (let y = 0; y < h; y++) { raw[y * (w * 4 + 1)] = 0; raw.set(px.subarray(y * w * 4, (y + 1) * w * 4), y * (w * 4 + 1) + 1); }
  const z = new Uint8Array(await new Response(new Blob([raw]).stream().pipeThrough(new CompressionStream('deflate'))).arrayBuffer());
  const ihdr = new Uint8Array(13); const dv = new DataView(ihdr.buffer);
  dv.setUint32(0, w); dv.setUint32(4, h); ihdr.set([8, 6, 0, 0, 0], 8);
  return new Blob([new Uint8Array([137, 80, 78, 71, 13, 10, 26, 10]), pngChunk('IHDR', ihdr), pngChunk('IDAT', z), pngChunk('IEND', new Uint8Array(0))], { type: 'image/png' });
}
function download(blob, name) {
  const a = document.createElement('a'); a.href = URL.createObjectURL(blob); a.download = name;
  document.body.appendChild(a); a.click(); a.remove();
  setTimeout(() => URL.revokeObjectURL(a.href), 60000);
}
async function doExport() {
  if (!state.kind || state.exporting) return;
  stopPlayback();
  state.exporting = true; document.body.dataset.state = 'exporting';
  for (const b of ['exportBtn', 'newBtn']) $(b).disabled = true;
  $('progress').value = 0;
  const base = state.file.name.replace(/\.[^.]+$/, '') + '_keyed';
  const t0 = performance.now();
  try {
    let blob, name;
    if (state.kind === 'image') {
      blob = await encodePng(keyFrame(state.bitmap, { toFbo: true }), state.w, state.h); name = base + '.png';
      state.lastExport = { frames: 1 };
    } else if (state.kind === 'gif') {
      const total = state.gifFrames.length;
      const fps = 1e6 / (state.gifFrames.map((f) => f.dur).sort((a, b) => a - b)[total >> 1] || 100000);
      blob = await encodeWebm(gifFrameIter(), total, fps, null); name = base + '.webm';
    } else {
      status('Reading video ...');
      const buf = await state.file.arrayBuffer();
      const isWebm = new Uint32Array(buf.slice(0, 4))[0] === 0xA3DF451A;
      const dem = isWebm ? demuxWebm(buf) : await demuxMp4(buf);
      const steps = dem.chunks.map((c) => c.duration).filter((d) => d > 0).sort((a, b) => a - b);
      const fps = 1e6 / (steps[steps.length >> 1] || 33333);
      const audio = await decodeAudio(state.file);
      blob = await encodeWebm(videoFrames(dem), dem.chunks.length, fps, audio); name = base + '.webm';
    }
    $('progress').value = 1;
    const ex = state.lastExport;
    status(`Done: ${name}, ${(blob.size / 1e6).toFixed(2)} MB, ${ex.frames} frame(s)` + (ex.codec ? `, ${ex.codec}` : '') +
      (state.kind === 'video' ? (ex.audio ? ', audio kept (Opus)' : ', no audio') : '') + ` in ${((performance.now() - t0) / 1000).toFixed(1)} s`);
    download(blob, name);
    document.body.dataset.state = 'done';
  } catch (e) {
    console.error(e); status('Export failed: ' + (e.message || e), true); document.body.dataset.state = 'error';
  } finally {
    state.exporting = false;
    for (const b of ['exportBtn', 'newBtn']) $(b).disabled = false;
    render();
  }
}

// ---------------- wiring ----------------
function syncOutputs() {
  $('strengthOut').textContent = $('strength').value + ' %';
  $('spillOut').textContent = $('spill').value + ' %';
  $('softOut').textContent = $('soft').value + ' %';
}
function wire() {
  const fi = $('fileInput');
  $('drop').addEventListener('click', () => fi.click());
  fi.addEventListener('change', () => { if (fi.files[0]) loadFile(fi.files[0]); fi.value = ''; });
  window.addEventListener('dragover', (e) => { e.preventDefault(); document.body.classList.add('dragging'); });
  window.addEventListener('dragleave', (e) => { if (!e.relatedTarget) document.body.classList.remove('dragging'); });
  window.addEventListener('drop', (e) => { e.preventDefault(); document.body.classList.remove('dragging');
    const f = e.dataTransfer.files[0]; if (f && !state.exporting) loadFile(f); });
  for (const id of ['strength', 'spill', 'soft']) $(id).addEventListener('input', () => { syncOutputs(); render(); });
  $('resetBtn').addEventListener('click', () => { for (const [k, v] of Object.entries(DEFAULTS)) $(k).value = v; syncOutputs(); render(); });
  $('autoKeyBtn').addEventListener('click', () => autoKey());
  $('pickBtn').addEventListener('click', () => { if (!state.picking) $('showOrig').checked = true, $('origFig').hidden = false; setPicking(!state.picking); });
  origCanvas.addEventListener('click', pickAt);
  $('showOrig').addEventListener('change', () => { $('origFig').hidden = !$('showOrig').checked; render(); });
  $('playBtn').addEventListener('click', togglePlay);
  const sc = $('scrub');
  sc.addEventListener('input', () => { scrubbing = true; if (state.playing) stopPlayback(); seekFraction(+sc.value / 1000); });
  sc.addEventListener('change', () => { scrubbing = false; });
  $('exportBtn').addEventListener('click', doExport);
  $('newBtn').addEventListener('click', () => $('fileInput').click());
  window.addEventListener('keydown', (e) => { if (e.code === 'Space' && e.target === document.body) { e.preventDefault(); togglePlay(); } });
  syncOutputs();
}
try {
  initGL(); wire();
  const missing = ['VideoEncoder', 'VideoDecoder', 'VideoFrame'].filter((k) => !(k in window));
  if (missing.length) status('This browser lacks ' + missing.join(', ') + ': video export will not work (use Chrome or Edge).', true);
} catch (e) { status(e.message, true); }
})();
