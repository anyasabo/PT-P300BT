/*
 * Verifies the label-builder port with node-canvas for headless rendering:
 *  - auto-fit converges so the rendered text height equals the printable area
 *  - rasterizeLabel rotates/mirrors/pads to 128px and produces binary output
 *  - emoji detection, tab expansion, unicode escapes, multiline dimensions
 *  - Python reference (printlabel.py) is invoked to confirm the target height
 */

import { execFileSync } from 'node:child_process';
import { createCanvas } from 'canvas';
import { describe, expect, test } from 'vitest';
import * as L from '../../src/label';
import { baseArgs, FONT_FAMILY, FONT_PATH, REPO_ROOT } from '../helpers';

const PY_HELLO = `
import contextlib, io, sys
import printlabel as pl
a = pl.set_args().parse_args(['-n', 'x', sys.argv[1], 'Hello'])
with contextlib.redirect_stdout(io.StringIO()):
    img = pl.build_label(a)
print(img.size[0], img.size[1])
`;

describe('Python reference (printlabel.py)', () => {
  test('height is 88', () => {
    const out = execFileSync('uv', ['run', 'python', '-c', PY_HELLO, FONT_PATH], {
      cwd: REPO_ROOT,
      encoding: 'utf8',
    });
    const [, height] = out.trim().split(/\s+/).map(Number);
    expect(height).toBe(88);
  });
});

describe('isEmojiChar', () => {
  test('grinning face is emoji', () => expect(L.isEmojiChar('\u{1F600}')).toBe(true));
  test('letter A is not emoji', () => expect(L.isEmojiChar('A')).toBe(false));
  test('variation selector is not emoji', () => expect(L.isEmojiChar('\uFE0F')).toBe(false));
  test('ZWJ is not emoji', () => expect(L.isEmojiChar('\u200D')).toBe(false));
});

describe('WebFont measurement', () => {
  const f = new L.WebFont(FONT_FAMILY, 40);

  test('getlength', () => {
    expect(f.getlength('Hello')).toBeGreaterThan(0);
  });

  test('getbbox lt', () => {
    const b = f.getbbox('Hello', { anchor: 'lt' });
    expect(b[2]).toBeGreaterThan(0);
    expect(b[3]).toBeGreaterThan(0);
  });
});

describe('calculateMultilineDimensions', () => {
  const f = new L.MixedFont(FONT_FAMILY, 40, {});

  test('three lines', () => {
    const d = L.calculateMultilineDimensions(['A', 'B', 'C'], f, 1.2);
    expect(d.height).toBeGreaterThan(0);
    expect(d.lineHeights.length).toBe(3);
  });

  test('single line height == rounded line height', () => {
    const single = L.calculateMultilineDimensions(['A'], f, 1.2);
    expect(single.height).toBe(Math.round(single.lineHeights[0] ?? Number.NaN));
  });
});

describe('buildLabel', () => {
  test('single line', async () => {
    const args = baseArgs();
    const img = await L.buildLabel(args);
    expect(img.height).toBe(88);
    expect(img.width).toBeGreaterThan(0);
    const padded = L.rasterizeLabel(img, args);
    expect(padded.width).toBe(128);
    expect(padded.height).toBe(img.width);
  });

  test('multiline', async () => {
    const img = await L.buildLabel(baseArgs({ text_to_print: ['Line1\\nLine2'] }));
    expect(img.height).toBe(88);
    expect(img.width).toBeGreaterThan(0);
  });

  test('three lines', async () => {
    const img = await L.buildLabel(baseArgs({ text_to_print: ['A\\nB\\nC'] }));
    expect(img.height).toBe(88);
    expect(img.width).toBeGreaterThan(0);
  });

  test('emoji', async () => {
    const img = await L.buildLabel(baseArgs({ text_to_print: ['A\u{1F60C}B'] }));
    expect(img.height).toBe(88);
    expect(img.width).toBeGreaterThan(0);
  });

  test('uniform font', async () => {
    const img = await L.buildLabel(baseArgs({ text_to_print: ['acca'], uniform_font: true }));
    expect(img.height).toBe(88);
    const img2 = await L.buildLabel(baseArgs({ text_to_print: ['accal'], uniform_font: true }));
    expect(img2.height).toBe(88);
  });

  test('fixed font size', async () => {
    const img = await L.buildLabel(baseArgs({ fixed_font_size: 40 }));
    expect(img.height).toBe(88);
    expect(img.width).toBeGreaterThan(0);
  });

  test('fixed width', async () => {
    const img = await L.buildLabel(baseArgs({ fixed_width: 30.0 }));
    expect(img.width).toBeGreaterThanOrEqual(Math.round(30.0 / L.MM_PER_DOT));
  });

  test('empty text throws', async () => {
    await expect(L.buildLabel(baseArgs({ text_to_print: [''] }))).rejects.toThrow(
      'Null image generated.',
    );
  });

  test('ligatures fall back to the plain draw', async () => {
    // node-canvas has no SVG font-feature-settings, so the ligature render
    // path falls back to the plain draw. The label must still build, and the
    // width must never be NARROWER than the plain one (the shaped-advance
    // widening that prevents right-side truncation can only grow it).
    const off = await L.buildLabel(baseArgs({ text_to_print: ['fi'] }));
    const on = await L.buildLabel(baseArgs({ text_to_print: ['fi'], ligatures: 'ss01' }));
    expect(on.height).toBe(88);
    expect(on.width).toBeGreaterThanOrEqual(off.width);
  });
});

describe('rasterizeLabel', () => {
  test('output is binary and 128 wide', () => {
    const img = createCanvas(20, 88);
    const ctx = img.getContext('2d');
    ctx.fillStyle = '#fff';
    ctx.fillRect(0, 0, 20, 88);
    ctx.fillStyle = '#000';
    ctx.fillRect(5, 20, 10, 40);
    // node-canvas stands in for the browser canvas.
    const padded = L.rasterizeLabel(img as unknown as HTMLCanvasElement, { threshold: 75 });
    expect(padded.width).toBe(128);
    const data = L.ctx2d(padded).getImageData(0, 0, 128, 20).data;
    const values = new Set(data.filter((_, i) => i % 4 === 0));
    expect([...values].every((v) => v === 0 || v === 255)).toBe(true);
  });
});

describe('expandTabs', () => {
  test('tab expands to next multiple of 4', () => expect(L.expandTabs('a\tb', 4)).toBe('a   b'));
  test('tab at column 4 -> 4 spaces', () => expect(L.expandTabs('abcd\te', 4)).toBe('abcd    e'));
  test('no tabs unchanged', () => expect(L.expandTabs('no tabs', 8)).toBe('no tabs'));
});

describe('decodeUnicodeEscapes', () => {
  test('\\u0041 -> A', () => expect(L.decodeUnicodeEscapes('\\u0041')).toBe('A'));
  test('\\U0001F600 -> emoji', () =>
    expect(L.decodeUnicodeEscapes('\\U0001F600')).toBe('\u{1F600}'));
  test('plain unchanged', () => expect(L.decodeUnicodeEscapes('plain')).toBe('plain'));
});
