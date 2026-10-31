/*
 * app.ts — GUI controller for the web port of printlabel.py.
 *
 * Mirrors ptgui.py: builds an args namespace from the controls, renders a
 * live preview (build_label + rasterize_label), and prints over Web Serial.
 */

import * as PTLabel from './label';
import * as PTPrinter from './printer';
import { errorMessage, errorName } from './printer';

declare global {
  interface Window {
    PTLabel: typeof PTLabel;
    PTPrinter: typeof PTPrinter;
  }
}

// Debug global: the browser tests call the label code through it.
Object.assign(window, { PTLabel, PTPrinter });

function $<T extends HTMLElement = HTMLElement>(id: string): T {
  const el = document.getElementById(id);
  if (!el) throw new Error(`Missing element #${id}`);
  return el as T;
}

// ---------------------------------------------------------------------------
// State
// ---------------------------------------------------------------------------
interface AppState {
  merge: { name: string; url: string }[];
  selectedMerge: number;
  transport: PTPrinter.SerialTransport | null;
  connected: boolean;
  busy: boolean;
  previewScheduled: boolean;
  zoom: number | null;
  pilImage: HTMLCanvasElement | null;
  fontFamily: string;
}

const state: AppState = {
  merge: [], // list of {name, url}
  selectedMerge: -1,
  transport: null,
  connected: false,
  busy: false,
  previewScheduled: false,
  zoom: null, // null => Fit
  pilImage: null, // current preview canvas (native size)
  fontFamily: 'Arial',
};

// ---------------------------------------------------------------------------
// Browser support check
// ---------------------------------------------------------------------------
function checkSupport(): boolean {
  const badge = $('support-badge');
  const banner = $('support-banner');
  const bannerText = $('support-banner-text');
  const supported = PTPrinter.SerialTransport.isSupported();
  if (supported) {
    badge.textContent = 'Web Serial available';
    badge.className = 'badge badge-ok';
    const isFirefox = /firefox/i.test(navigator.userAgent);
    badge.title =
      'This browser exposes the Web Serial API with a working ' +
      'requestPort(). Chrome/Edge (desktop, 117+) fully support Bluetooth ' +
      'RFCOMM/SPP printing.' +
      (isFirefox
        ? ' Firefox 155+ implements Web Serial; if the printer ' +
          'does not appear in the chooser or the transfer fails, use ' +
          'Chrome or Edge.'
        : '');
    banner.classList.add('hidden');
  } else {
    badge.textContent = 'Web Serial unavailable';
    badge.className = 'badge badge-err';
    banner.classList.remove('hidden');
    bannerText.textContent =
      'This browser does not expose the Web Serial API, so printing to the ' +
      'PT-P300BT is not possible here. Use Chrome or Edge (desktop) on ' +
      'Windows, macOS or Linux. The preview and all label algorithms still ' +
      'work in any modern browser.';
  }
  return supported;
}

// ---------------------------------------------------------------------------
// Font list: a curated list, replaced by the installed fonts where the browser
// can list them (queryLocalFonts, Chrome/Edge), plus user-loaded font files via
// the FontFace API.
// ---------------------------------------------------------------------------
const SYSTEM_FONTS = [
  'Arial',
  'Arial Black',
  'Calibri',
  'Cambria',
  'Candara',
  'Comic Sans MS',
  'Consolas',
  'Courier New',
  'Georgia',
  'Impact',
  'Lucida Console',
  'Segoe UI',
  'Tahoma',
  'Times New Roman',
  'Trebuchet MS',
  'Verdana',
  'DejaVu Sans',
  'DejaVu Sans Mono',
  'Liberation Sans',
  'Noto Sans',
  'Roboto',
  'Ubuntu',
  'Helvetica',
  'Menlo',
  'Monaco',
];

function populateFonts(families = SYSTEM_FONTS) {
  const sel = $<HTMLSelectElement>('fontname');
  const current = sel.value || 'Arial';
  for (const o of sel.querySelectorAll('option:not([data-loaded])')) o.remove();
  for (const f of families) {
    const o = document.createElement('option');
    o.value = f;
    o.textContent = f;
    sel.appendChild(o);
  }
  sel.value = current;
  if (!sel.value) sel.selectedIndex = 0;
  state.fontFamily = sel.value;
}

// Styles of each installed family: family -> [{ style, postscriptName }].
const installedFaces = new Map<string, { style: string; postscriptName: string }[]>();
const activatedFaces = new Set<string>();
let installedFontsListed = false;

// A style is drawn through its PostScript name: a FontFace with that family
// name gives the canvas the exact face, and Chrome resolves the same name in
// the SVG ligature path, which cannot see the page's FontFaces.
async function activateFace(name: string) {
  if (activatedFaces.has(name)) return;
  const face = new FontFace(name, `local('${name}')`);
  await face.load();
  document.fonts.add(face);
  activatedFaces.add(name);
}

function populateStyles() {
  const sel = $<HTMLSelectElement>('fontstyle');
  const faces = installedFaces.get($<HTMLSelectElement>('fontname').value) || [];
  sel.innerHTML = '';
  for (const f of faces) {
    const o = document.createElement('option');
    o.value = f.postscriptName;
    o.textContent = f.style;
    sel.appendChild(o);
  }
  const regular = faces.find((f) => f.style === 'Regular');
  if (regular) sel.value = regular.postscriptName;
  $('fontstyle-field').hidden = faces.length < 2;
}

async function applyFontChoice() {
  const style = $<HTMLSelectElement>('fontstyle').value;
  try {
    if (style) await activateFace(style);
    state.fontFamily = style || $<HTMLSelectElement>('fontname').value;
  } catch (e) {
    $('font-status').textContent = `Failed: ${errorMessage(e)}`;
    return;
  }
  populateLigatures();
  schedulePreview();
}

async function loadInstalledFonts() {
  const status = $('font-status');
  status.textContent = 'Listing installed fonts…';
  try {
    const fonts = await window.queryLocalFonts();
    if (!fonts.length) {
      status.textContent = "No fonts returned: check the site's font permission";
      return;
    }
    installedFaces.clear();
    for (const { family, style, postscriptName } of fonts) {
      let faces = installedFaces.get(family);
      if (!faces) {
        faces = [];
        installedFaces.set(family, faces);
      }
      faces.push({ style, postscriptName });
    }
    const families = [...installedFaces.keys()].sort((a, b) => a.localeCompare(b));
    populateFonts(families);
    populateStyles();
    await applyFontChoice();
    installedFontsListed = true;
    status.textContent = `Listed ${families.length} installed fonts`;
  } catch (e) {
    status.textContent = `Failed: ${errorMessage(e)}`;
  }
}

// The permission prompt needs a click: the list loads by itself once the
// permission is granted, otherwise the first click on the dropdown asks for it.
async function initInstalledFonts() {
  if (!('queryLocalFonts' in window)) {
    $('font-status').textContent = 'This browser cannot list installed fonts';
    return;
  }
  $('font-list-btn').hidden = false;
  const perm = await navigator.permissions.query({ name: 'local-fonts' }).catch(() => null);
  if (perm && perm.state === 'granted') {
    await loadInstalledFonts();
    return;
  }
  $('font-status').textContent = 'Click the font list to add your installed fonts';
  $('fontname').addEventListener(
    'mousedown',
    (e) => {
      if (installedFontsListed) return;
      e.preventDefault();
      loadInstalledFonts();
    },
    { once: true },
  );
}

async function loadFontFile(file: File) {
  try {
    const buf = await file.arrayBuffer();
    const family = file.name.replace(/\.[^.]+$/, '');
    const face = new FontFace(family, buf);
    await face.load();
    document.fonts.add(face);
    const sel = $<HTMLSelectElement>('fontname');
    const o = document.createElement('option');
    o.value = family;
    o.dataset.loaded = '1';
    o.textContent = `${family} (loaded)`;
    sel.appendChild(o);
    sel.value = family;
    populateStyles();
    await applyFontChoice();
    $('font-status').textContent = `Loaded ${file.name}`;
  } catch (e) {
    $('font-status').textContent = `Failed: ${errorMessage(e)}`;
  }
}

// ---------------------------------------------------------------------------
// Args builder (mirrors ptgui._make_args)
// ---------------------------------------------------------------------------
type ValueElement = HTMLInputElement | HTMLSelectElement | HTMLTextAreaElement;

function num(id: string, cast: (v: string) => number = Number, def = 0): number {
  const v = $<ValueElement>(id).value;
  if (v === '' || v == null) return def;
  const n = cast(v);
  return Number.isNaN(n) ? def : n;
}
function bool(id: string): boolean {
  return $<HTMLInputElement>(id).checked;
}
function str(id: string): string {
  return $<ValueElement>(id).value;
}

function makeArgs(noPrint: boolean): PTLabel.LabelArgs {
  const text = str('text');
  const cliText = text ? text.split('\n').join('\\n') : '';
  const fontScale = num('font_scale', Number, 100);
  return {
    comport: 'web-serial',
    fixed_width: num('fixed_width', Number, 0) || null,
    fixed_font_size: num('fixed_font_size', Number, 0) || null,
    fontname: state.fontFamily,
    text_to_print: cliText ? [cliText] : [],
    unicode: bool('unicode'),
    lines: bool('lines'),
    image: null,
    merge: state.merge.map((m) => m.url),
    resize: num('resize', Number, 1.0),
    x_merge: num('x_merge', Number, 0),
    y_merge: num('y_merge', Number, 12),
    merge_gap: num('merge_gap', Number, 0),
    no_print: noPrint,
    no_feed: bool('no_feed'),
    auto_cut: bool('auto_cut'),
    end_margin: num('end_margin', Number, 0),
    raw: bool('raw'),
    nocomp: bool('nocomp'),
    fill: str('fill') || 'black',
    stroke_fill: str('stroke_fill').trim() || null,
    stroke_width: num('stroke_width', Number, 0),
    text_size: num('text_size', Number, 0) || null,
    font_scale: fontScale === 100 ? null : fontScale,
    h_padding: num('h_padding', Number, 5),
    v_shift: num('v_shift', Number, 0),
    line_spacing: num('line_spacing', Number, 1.2),
    center_text: bool('center_text'),
    tape_width: num('tape_width', Number, 12.0),
    emoji_print_area: bool('emoji_print_area'),
    uniform_font: bool('uniform_font'),
    ligatures: str('ligatures') || null,
    mono_emoji: bool('mono_emoji'),
    luma_lo: num('luma_lo', Number, 140.0),
    luma_hi: num('luma_hi', Number, 175.0),
    tab_width: num('tab_width', Number, 8),
    white_level: num('white_level', Number, 240),
    threshold: num('threshold', Number, 75),
  };
}

// ---------------------------------------------------------------------------
// Preview
// ---------------------------------------------------------------------------
function schedulePreview() {
  if (!bool('auto_preview')) return;
  if (state.busy) {
    state.previewScheduled = true;
    return;
  }
  state.previewScheduled = true;
  setTimeout(runPreview, 150);
}

async function runPreview() {
  state.previewScheduled = false;
  if (state.busy) return;
  state.busy = true;
  try {
    const args = makeArgs(true);
    if (!args.text_to_print.length && !args.merge.length) {
      clearPreview();
      setStatus('Type some text to see the preview.');
      return;
    }
    const image = await PTLabel.buildLabel(args);
    const padded = PTLabel.rasterizeLabel(image, args);
    const showConv = bool('preview_conv');
    state.pilImage = showConv ? padded : image;
    renderPreview();
    const cm = ((padded.height * PTLabel.MM_PER_DOT) / 10).toFixed(1);
    setStatus(
      padded.height > MAX_RASTER_LINES
        ? tooLongMessage(padded.height)
        : `${padded.width}×${padded.height} raster, ${cm} cm of tape.`,
    );
  } catch (e) {
    if (String(errorMessage(e)).includes('Null image')) {
      clearPreview();
      setStatus('Type some text to see the preview.');
    } else {
      setStatus(`Error: ${errorMessage(e)}`);
      log(`ERROR: ${errorMessage(e)}`);
    }
  } finally {
    state.busy = false;
    if (state.previewScheduled) schedulePreview();
  }
}

function clearPreview() {
  state.pilImage = null;
  const cv = $<HTMLCanvasElement>('preview-canvas');
  cv.width = 0;
  cv.height = 0;
  $('preview-empty').classList.remove('hidden');
  $('zoom-info').textContent = '';
}

function renderPreview() {
  const img = state.pilImage;
  if (!img) return;
  $('preview-empty').classList.add('hidden');
  const wrap = $('canvas-wrap');
  let scale: number;
  if (state.zoom === null) {
    const avail = Math.max(wrap.clientWidth - 40, 100);
    scale = Math.min(avail / img.width, 2.0);
  } else {
    scale = state.zoom;
  }
  const cv = $<HTMLCanvasElement>('preview-canvas');
  cv.width = Math.max(1, Math.round(img.width * scale));
  cv.height = Math.max(1, Math.round(img.height * scale));
  const ctx = PTLabel.ctx2d(cv);
  ctx.imageSmoothingEnabled = scale < 2;
  ctx.clearRect(0, 0, cv.width, cv.height);
  ctx.drawImage(img, 0, 0, cv.width, cv.height);
  $('zoom-info').textContent = `${cv.width}×${cv.height} (${Math.round(scale * 100)}%)`;
}

function setZoom(mode: 'fit' | 'in' | 'out' | 'tape') {
  if (mode === 'fit') state.zoom = null;
  else if (mode === 'in') state.zoom = Math.min((state.zoom || 1) * 1.25, 4);
  else if (mode === 'out') state.zoom = Math.max((state.zoom || 1) / 1.25, 0.1);
  else if (mode === 'tape') {
    // 12 mm tape at 203 dpi ≈ 96 dots; show at true physical size.
    const dpi = 96; // CSS px per inch assumption
    const tapeDots = Math.round((12 * 203) / 25.4);
    state.zoom = Math.min((12 * dpi) / 25.4 / tapeDots, 2.0);
  }
  renderPreview();
}

// ---------------------------------------------------------------------------
// Status / log
// ---------------------------------------------------------------------------
function setStatus(s: string) {
  $('status').textContent = s;
}
function log(s: string) {
  const el = $('log');
  el.textContent += `${s}\n`;
  el.scrollTop = el.scrollHeight;
}

// ---------------------------------------------------------------------------
// Merge images
// ---------------------------------------------------------------------------
function renderMergeList() {
  const ul = $('merge-list');
  ul.innerHTML = '';
  state.merge.forEach((m, i) => {
    const li = document.createElement('li');
    li.textContent = m.name;
    if (i === state.selectedMerge) li.classList.add('selected');
    li.onclick = () => {
      state.selectedMerge = i;
      renderMergeList();
    };
    ul.appendChild(li);
  });
}

function addMergeFile(file: File) {
  const url = URL.createObjectURL(file);
  state.merge.push({ name: file.name, url });
  renderMergeList();
  schedulePreview();
}

function delMerge() {
  if (state.selectedMerge >= 0) {
    state.merge.splice(state.selectedMerge, 1);
    state.selectedMerge = -1;
    renderMergeList();
    schedulePreview();
  }
}

// ---------------------------------------------------------------------------
// Printer connection & print
// ---------------------------------------------------------------------------
async function connectPrinter() {
  if (!checkSupport()) return;
  const btn = $<HTMLButtonElement>('connect-btn');
  btn.disabled = true;
  log('=> Connect: choose the printer in the browser dialog...');
  let started: number | null = null;
  try {
    const port = await PTPrinter.SerialTransport.requestPort();
    const transport = new PTPrinter.SerialTransport(port);
    const kind = port.getInfo().bluetoothServiceClassId ? 'direct Bluetooth' : 'serial port';
    log(`=> Connecting over ${kind} (this can take several seconds)...`);
    setStatus(`Connecting over ${kind}...`);
    started = performance.now();
    await transport.open(9600, (attempt) => {
      log(`=> Attempt ${attempt} failed, retrying while the Bluetooth link is up...`);
    });
    state.transport = transport;
    state.connected = true;
    $('port-status').textContent = 'Connected';
    $('connect-btn').textContent = 'Disconnect';
    log(`=> Printer connected in ${((performance.now() - started) / 1000).toFixed(1)} s.`);
  } catch (e) {
    if (errorName(e) === 'NotFoundError') {
      log('=> Connect cancelled: no port selected.');
      setStatus('No port selected.');
      return;
    }
    let msg = errorMessage(e) || String(e);
    if (started !== null) {
      msg += ` (${errorName(e)}, after ${((performance.now() - started) / 1000).toFixed(1)} s)`;
      msg += '. Check that the printer is on: it turns itself off when idle.';
    }
    if (/user gesture/i.test(msg)) {
      msg =
        'The browser blocked the serial-permission prompt (it must be ' +
        'opened directly by a click). Reload the page and click ' +
        '"Connect printer" again.';
    } else if (/secure context|insecure/i.test(msg) || window.location.protocol === 'file:') {
      msg =
        'Web Serial needs a secure context: serve this page over ' +
        'http://localhost (see web/README.md) instead of ' +
        window.location.protocol +
        '//.';
    }
    log(`Connection failed: ${msg}`);
    setStatus(`Connection failed: ${msg}`);
  } finally {
    btn.disabled = false;
  }
}

async function disconnectPrinter() {
  if (state.transport) {
    await state.transport.close();
    state.transport = null;
  }
  state.connected = false;
  $('port-status').textContent = 'Not connected';
  $('connect-btn').textContent = 'Connect printer';
  log('=> Printer disconnected.');
}

// The printer accepts a job over the limit but does not print it correctly.
const MAX_RASTER_LINES = 3536; // 499 mm at 180 DPI

function tooLongMessage(lines: number): string {
  return (
    `Label is too long: ${lines} lines, the printer limit is ` +
    `${MAX_RASTER_LINES} (499 mm). Split it into shorter labels.`
  );
}

async function doPrint() {
  if (!state.connected || !state.transport) {
    setStatus('Connect the printer first.');
    return;
  }
  if (state.busy) return;
  if (!confirm('Send the label to the printer?')) return;
  state.busy = true;
  const printBtn = $<HTMLButtonElement>('print-btn');
  printBtn.disabled = true;
  try {
    const args = makeArgs(false);
    log('=> Building label…');
    const image = await PTLabel.buildLabel(args);
    const padded = PTLabel.rasterizeLabel(image, args);
    if (padded.height > MAX_RASTER_LINES) throw new Error(tooLongMessage(padded.height));
    const data = imageDataToBytes(padded);
    await PTPrinter.doPrintJob(
      state.transport,
      args,
      data,
      (line) => log(line),
      (bar) => setStatus(`Sending [${bar}]`),
    );
    setStatus('Print job sent.');
  } catch (e) {
    log(`ERROR: ${errorMessage(e)}`);
    setStatus(`Error: ${errorMessage(e)}`);
  } finally {
    state.busy = false;
    printBtn.disabled = false;
  }
}

// Convert the padded 1-bit canvas to the raw 16-bytes-per-line raster.
function imageDataToBytes(canvas: HTMLCanvasElement): Uint8Array {
  const w = canvas.width,
    h = canvas.height;
  const ctx = PTLabel.ctx2d(canvas);
  const img = ctx.getImageData(0, 0, w, h).data;
  const bytesPerLine = w / 8;
  const out = new Uint8Array(bytesPerLine * h);
  for (let y = 0; y < h; y++) {
    for (let x = 0; x < w; x++) {
      const i = (y * w + x) * 4;
      // rasterizeLabel() outputs the INK as bright pixels (255): it applies
      // invert+threshold, so text -> 255 and background -> 0, exactly like
      // the Python '1'-mode raster where a 255 pixel packs to bit 1.
      // Setting the bit for the BRIGHT pixel keeps the byte stream identical
      // to printlabel.rasterize_label().tobytes() (mapping the dark pixel
      // instead inverted the print: white text on a black label).
      const ink = (img[i] ?? 0) >= 128 ? 1 : 0;
      const o = y * bytesPerLine + (x >> 3);
      if (ink) out[o] = (out[o] ?? 0) | (0x80 >> (x & 7));
    }
  }
  return out;
}

// ---------------------------------------------------------------------------
// Save PNG
// ---------------------------------------------------------------------------
function savePng() {
  if (!state.pilImage) {
    setStatus('Nothing to save.');
    return;
  }
  const a = document.createElement('a');
  a.download = 'label.png';
  a.href = state.pilImage.toDataURL('image/png');
  a.click();
}

// ---------------------------------------------------------------------------
// Ligature features — dynamic list from the selected font (port of
// ptgui._refresh_ligature_combo). A tag is offered when enabling it changes
// the shaped rendering of a probe sample, i.e. the font exposes and applies it.
// ---------------------------------------------------------------------------
function populateLigatures() {
  const sel = $<HTMLSelectElement>('ligatures');
  const current = sel.value || '';
  sel.innerHTML = '';
  const off = document.createElement('option');
  off.value = '';
  off.textContent = '(off)';
  sel.appendChild(off);
  const feats = PTLabel.probeLigatureFeatures(state.fontFamily);
  for (const t of feats) {
    const o = document.createElement('option');
    o.value = t;
    o.textContent = t;
    sel.appendChild(o);
  }
  if (feats.length) {
    $('ligature-status').textContent =
      `${feats.length} feature(s) available for ${state.fontFamily}`;
  } else {
    $('ligature-status').textContent = `no GSUB features detected for ${state.fontFamily}`;
  }
  // Keep the selection when the font is re-picked (features are font-specific).
  if ([...sel.options].some((o) => o.value === current)) sel.value = current;
}

// ---------------------------------------------------------------------------
// Output log: Copy / Clear
// ---------------------------------------------------------------------------
async function copyLog() {
  const text = $('log').textContent ?? '';
  try {
    await navigator.clipboard.writeText(text);
    setStatus('Output copied to the clipboard.');
  } catch (_e) {
    // Clipboard API needs a secure context: fall back to a hidden textarea.
    const ta = document.createElement('textarea');
    ta.value = text;
    ta.style.position = 'fixed';
    ta.style.left = '-9999px';
    document.body.appendChild(ta);
    ta.select();
    try {
      document.execCommand('copy');
      setStatus('Output copied to the clipboard.');
    } catch (_e2) {
      setStatus('Copy failed: select the text manually.');
    }
    document.body.removeChild(ta);
  }
}

// ---------------------------------------------------------------------------
// Wiring
// ---------------------------------------------------------------------------
function wire() {
  // Live preview on any control change.
  document.querySelectorAll('input, select, textarea').forEach((el) => {
    el.addEventListener('input', schedulePreview);
    el.addEventListener('change', schedulePreview);
  });
  $('fontname').addEventListener('change', () => {
    populateStyles();
    applyFontChoice();
  });
  $('fontstyle').addEventListener('change', applyFontChoice);
  $('font-list-btn').onclick = loadInstalledFonts;
  const fontUpload = $<HTMLInputElement>('font-upload');
  $('font-upload-btn').onclick = () => fontUpload.click();
  fontUpload.onchange = () => {
    const file = fontUpload.files?.[0];
    if (file) {
      loadFontFile(file);
    }
  };

  $('log-copy').onclick = copyLog;
  $('log-clear').onclick = () => {
    $('log').textContent = '';
  };

  const mergeFile = $<HTMLInputElement>('merge-file');
  $('merge-add').onclick = () => mergeFile.click();
  mergeFile.onchange = () => {
    const file = mergeFile.files?.[0];
    if (file) addMergeFile(file);
  };
  $('merge-del').onclick = delMerge;

  $('connect-btn').onclick = () => (state.connected ? disconnectPrinter() : connectPrinter());
  $('print-btn').onclick = doPrint;
  $('refresh-btn').onclick = runPreview;
  $('save-png').onclick = savePng;

  $('zoom-in').onclick = () => setZoom('in');
  $('zoom-out').onclick = () => setZoom('out');
  $('zoom-fit').onclick = () => setZoom('fit');
  $('zoom-tape').onclick = () => setZoom('tape');

  // Drag-to-pan on the preview canvas (mouse + touch).
  const wrap = $('canvas-wrap');
  let pan: { x: number; y: number; sl: number; st: number } | null = null;
  const cv = $<HTMLCanvasElement>('preview-canvas');
  cv.addEventListener('pointerdown', (e) => {
    if (!state.pilImage) return;
    pan = { x: e.clientX, y: e.clientY, sl: wrap.scrollLeft, st: wrap.scrollTop };
    cv.classList.add('dragging');
    cv.setPointerCapture(e.pointerId);
    e.preventDefault();
  });
  cv.addEventListener('pointermove', (e) => {
    if (!pan) return;
    wrap.scrollLeft = pan.sl - (e.clientX - pan.x);
    wrap.scrollTop = pan.st - (e.clientY - pan.y);
  });
  const endPan = () => {
    pan = null;
    cv.classList.remove('dragging');
  };
  cv.addEventListener('pointerup', endPan);
  cv.addEventListener('pointercancel', endPan);

  window.addEventListener('resize', () => {
    if (state.zoom === null) renderPreview();
  });
  document.addEventListener('keydown', (e) => {
    if (e.key === 'F5') {
      e.preventDefault();
      runPreview();
    }
    if (e.ctrlKey && e.key === 'p') {
      e.preventDefault();
      doPrint();
    }
  });
}

// ---------------------------------------------------------------------------
// Init
// ---------------------------------------------------------------------------
function init() {
  checkSupport();
  populateFonts();
  populateLigatures();
  wire();
  clearPreview();
  initInstalledFonts();
  log('PT-P300BT Label Designer (web) ready.');
  if (!PTPrinter.SerialTransport.isSupported()) {
    log('Web Serial unavailable: printing disabled, preview still works.');
  }
}

document.addEventListener('DOMContentLoaded', init);
