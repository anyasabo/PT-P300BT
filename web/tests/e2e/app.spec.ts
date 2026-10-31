/*
 * End-to-end browser test of the PT-P300BT web app: preview rendering, all
 * controls, zoom, converted-raster view, ligatures, emoji, multiline, uniform
 * font, fixed width, save PNG, print guard. The unsupported-browser banner is
 * in support.spec.ts.
 *
 * Tests that look at the rendered text load the fixture font first.
 */

import type { Page } from '@playwright/test';
import { baseArgs } from '../helpers';
import {
  expect,
  LOADED_FAMILY,
  loadFixtureFont,
  openApp,
  optionValues,
  preview,
  previewChange,
  setText,
  test,
} from './app-test';

const PRINTER_SERVICE = '00001101-0000-1000-8000-00805f9b34fb';

async function stubLocalFonts(page: Page, fonts: Partial<FontData>[]): Promise<void> {
  await page.evaluate((list) => {
    Object.assign(window, { queryLocalFonts: async () => list });
  }, fonts);
}

// A Bluetooth port whose first open fails like Chrome's does on macOS.
async function stubPortThatOpensOnRetry(page: Page): Promise<void> {
  await page.evaluate((serviceClassId) => {
    let opens = 0;
    Object.assign(navigator.serial, {
      requestPort: async () => ({
        getInfo: () => ({ bluetoothServiceClassId: serviceClassId }),
        open: async () => {
          if (++opens === 1) {
            throw new DOMException('Failed to open serial port.', 'NetworkError');
          }
        },
        setSignals: async () => {},
        close: async () => {},
        readable: new ReadableStream(),
        writable: new WritableStream(),
      }),
    });
  }, PRINTER_SERVICE);
}

test.beforeEach(async ({ page }) => {
  await openApp(page);
});

test.describe('page load', () => {
  test('shows the app and the support state', async ({ page }) => {
    expect(await page.title()).not.toBe('');
    await expect(page.locator('#support-badge')).toBeVisible();
    await expect(page.locator('#support-badge')).toHaveText('Web Serial available');
    await expect(page.locator('#support-banner')).toBeHidden();
    await expect(page.locator('#preview-canvas')).toBeAttached();
  });

  test('all advanced controls are present', async ({ page }) => {
    const ids = [
      'font_scale',
      'line_spacing',
      'h_padding',
      'v_shift',
      'text_size',
      'fixed_width',
      'tape_width',
      'fixed_font_size',
      'luma_lo',
      'luma_hi',
      'fill',
      'stroke_fill',
      'stroke_width',
      'end_margin',
      'unicode',
      'lines',
      'resize',
      'x_merge',
      'y_merge',
      'merge_gap',
      'white_level',
      'threshold',
      'no_print',
      'auto_cut',
      'no_feed',
      'raw',
      'nocomp',
      'tab_width',
    ];
    for (const id of ids) await expect(page.locator(`#${id}`)).toBeAttached();
  });

  test('merge controls are present', async ({ page }) => {
    await expect(page.locator('#merge-add')).toBeVisible();
    await expect(page.locator('#merge-del')).toBeVisible();
    await expect(page.locator('#merge-list')).toBeAttached();
  });
});

test.describe('font list', () => {
  test('starts with the curated list', async ({ page }) => {
    const fonts = await optionValues(page, '#fontname');
    expect(fonts.length).toBeGreaterThanOrEqual(20);
    expect(fonts).toContain('Arial');
    expect(fonts).toContain('DejaVu Sans Mono');
  });

  test('installed fonts replace the list and fill the Style list', async ({ page }) => {
    await expect(page.locator('#font-list-btn')).toBeVisible();
    await stubLocalFonts(page, [
      { family: 'Zed 3D', style: 'Regular', postscriptName: 'Arial-BoldMT' },
      { family: 'Arial', style: 'Regular', postscriptName: 'ArialMT' },
      { family: 'Arial', style: 'Bold', postscriptName: 'Arial-BoldMT' },
    ]);
    await page.click('#font-list-btn');
    await expect(page.locator('#fontname option')).toHaveCount(2);
    expect(await optionValues(page, '#fontname')).toEqual(['Arial', 'Zed 3D']);
    await expect(page.locator('#fontname')).toHaveValue('Arial');
    await expect(page.locator('#fontstyle')).toHaveValue('ArialMT');
    await page.selectOption('#fontname', 'Zed 3D');
    await expect(page.locator('#fontstyle-field')).toBeHidden();
  });

  test('the first click on the font list loads the installed fonts', async ({ page }) => {
    await expect(page.locator('#font-status')).toContainText('Click the font list');
    await stubLocalFonts(page, [
      { family: 'Zed 3D', style: 'Regular', postscriptName: 'Arial-BoldMT' },
      { family: 'Arial', style: 'Regular', postscriptName: 'ArialMT' },
    ]);
    await page.dispatchEvent('#fontname', 'mousedown');
    await expect(page.locator('#fontname option')).toHaveCount(2);
  });

  test('Load font file adds the font and the preview uses it', async ({ page }) => {
    const before = await setText(page, 'Hello');
    const after = await previewChange(page, () => loadFixtureFont(page));
    await expect(page.locator('#fontname option:checked')).toHaveText(`${LOADED_FAMILY} (loaded)`);
    expect(after.ink).not.toBe(before.ink);
  });
});

test.describe('connect', () => {
  test('a failed connection gives feedback', async ({ page }) => {
    await page.evaluate((serviceClassId) => {
      Object.assign(navigator.serial, {
        requestPort: async () => ({
          getInfo: () => ({ bluetoothServiceClassId: serviceClassId }),
          open: () =>
            new Promise((_, reject) => {
              setTimeout(
                () => reject(new DOMException('Failed to open serial port.', 'NetworkError')),
                500,
              );
            }),
        }),
      });
    }, PRINTER_SERVICE);
    await page.click('#connect-btn');
    const log = page.locator('#log');
    await expect(log).toContainText('Connecting over');
    await expect(page.locator('#connect-btn')).toBeDisabled();
    await expect(log).toContainText('direct Bluetooth');
    await expect(log).toContainText('Connection failed');
    await expect(log).toContainText('NetworkError, after ');
    await expect(page.locator('#connect-btn')).toBeEnabled();
  });

  test('a Bluetooth open is retried', async ({ page }) => {
    await stubPortThatOpensOnRetry(page);
    await page.click('#connect-btn');
    await expect(page.locator('#log')).toContainText('Printer connected');
    await expect(page.locator('#log')).toContainText('Attempt 1 failed, retrying');
    await expect(page.locator('#port-status')).toHaveText('Connected');
  });

  test('a label over the printer limit is warned about and not sent', async ({ page }) => {
    await loadFixtureFont(page);
    await stubPortThatOpensOnRetry(page);
    await page.click('#connect-btn');
    await expect(page.locator('#port-status')).toHaveText('Connected');

    await page.fill('#text', 'W'.repeat(100));
    await page.click('#refresh-btn');
    await expect(page.locator('#status')).toContainText('too long');

    page.on('dialog', (d) => d.accept());
    const log = page.locator('#log');
    // doPrint does nothing while a preview runs, and the live preview can still be queued.
    await expect(async () => {
      await page.click('#print-btn');
      await expect(log).toContainText('ERROR: Label is too long', { timeout: 500 });
    }).toPass();
    await expect(log).not.toContainText('Querying printer status');
  });
});

test.describe('ligatures', () => {
  test.beforeEach(async ({ page }) => {
    await loadFixtureFont(page);
  });

  test('the list starts with (off) and the status names the result', async ({ page }) => {
    const options = await optionValues(page, '#ligatures');
    expect(options[0]).toBe('');
    expect(options).not.toContain('liga');
    await expect(page.locator('#ligature-status')).toContainText('feature');
  });

  // Known bug: probeLigatureFeatures only sees a feature that changes the text
  // width, and no feature changes a width in a monospaced font. The fixture has
  // ss01..ss10, zero and calt, but the list stays empty.
  test.fail('the list offers the features of a monospaced font', async ({ page }) => {
    expect(await optionValues(page, '#ligatures')).toContain('ss02');
  });

  test('a GSUB feature changes the preview', async ({ page }) => {
    const off = await setText(page, '000');
    // The list cannot offer `zero` (see above), so add it like the probe would.
    await page.evaluate(() => {
      document.querySelector<HTMLSelectElement>('#ligatures')?.add(new Option('zero', 'zero'));
    });
    const on = await previewChange(page, () => page.selectOption('#ligatures', 'zero'));
    expect(on.ink).not.toBe(off.ink);
    const back = await previewChange(page, () => page.selectOption('#ligatures', ''));
    expect(back.ink).toBe(off.ink);
  });

  // Known bug: svgRender draws through an SVG image, and an SVG image cannot
  // see the FontFaces of the page, so a loaded font falls back to the default
  // font as soon as a feature is on. ss01 does not touch these letters, so the
  // two renders match when the right font is used. Observed: 86% (macOS) and
  // 98% (Linux) of the ink differs here, and 0% with the font installed.
  test.fail('a feature render keeps the loaded font', async ({ page }) => {
    const { differing, ink } = await page.evaluate(
      async (args) => {
        const L = window.PTLabel;
        const dots = async (ligatures: string | null) => {
          const image = await L.buildLabel({ ...args, ligatures });
          const d = L.ctx2d(image).getImageData(0, 0, image.width, image.height).data;
          return d.filter((_, i) => i % 4 === 0).map((v) => (v < 128 ? 1 : 0));
        };
        const plain = await dots(null);
        const feature = await dots('ss01');
        return {
          differing: plain.filter((v, i) => v !== feature[i]).length,
          ink: plain.filter((v) => v === 1).length,
        };
      },
      baseArgs({ fontname: LOADED_FAMILY, text_to_print: ['HIW'] }),
    );
    expect(differing / ink).toBeLessThan(0.2);
  });
});

test.describe('preview', () => {
  test.beforeEach(async ({ page }) => {
    await loadFixtureFont(page);
  });

  test('renders text and reports the raster', async ({ page }) => {
    const p = await setText(page, 'Hello');
    expect(p.ink).toBeGreaterThan(0);
    await expect(page.locator('#status')).toContainText('raster');
  });

  test('renders multiline text', async ({ page }) => {
    const p = await setText(page, 'Line1\nLine2');
    expect(p.ink).toBeGreaterThan(0);
    await expect(page.locator('#status')).toContainText('raster');
  });

  test('renders emoji', async ({ page }) => {
    const p = await setText(page, 'A\u{1F60C}B');
    expect(p.ink).toBeGreaterThan(0);
  });

  test('renders with uniform font sizing', async ({ page }) => {
    await page.check('#uniform_font');
    const p1 = await setText(page, 'acca');
    const p2 = await setText(page, 'accal');
    expect(p1.ink).toBeGreaterThan(0);
    expect(p2.ink).toBeGreaterThan(0);
  });

  test('renders with a fixed width', async ({ page }) => {
    await setText(page, 'Hi');
    await previewChange(page, () => page.fill('#fixed_width', '30'));
    await expect(page.locator('#status')).toContainText('raster');
  });

  test('renders with a font scale', async ({ page }) => {
    await setText(page, 'Scale');
    const p = await previewChange(page, () => page.fill('#font_scale', '60'));
    expect(p.ink).toBeGreaterThan(0);
  });

  test('renders with centered text', async ({ page }) => {
    await setText(page, 'Center');
    await page.check('#center_text');
    await expect.poll(async () => (await preview(page)).ink).toBeGreaterThan(0);
  });

  test('renders rulers', async ({ page }) => {
    // Rulers are on by default.
    await setText(page, 'Rulers');
    await previewChange(page, () => page.uncheck('#lines'));
    const p = await previewChange(page, () => page.check('#lines'));
    expect(p.ink).toBeGreaterThan(0);
  });

  test('renders unicode escapes', async ({ page }) => {
    await setText(page, '\\u0041\\u0042');
    const p = await previewChange(page, () => page.check('#unicode'));
    expect(p.ink).toBeGreaterThan(0);
  });

  test('renders a TAB', async ({ page }) => {
    const p = await setText(page, 'a\tb');
    expect(p.ink).toBeGreaterThan(0);
  });

  test('shows the converted raster', async ({ page }) => {
    const normal = await setText(page, 'Raster');
    const conv = await previewChange(page, () => page.check('#preview_conv'));
    expect(conv.w).toBe(128 * 2);
    expect(conv.w).not.toBe(normal.w);
  });

  test('zoom buttons change the zoom', async ({ page }) => {
    await setText(page, 'Zoom');
    const zoomInfo = page.locator('#zoom-info');
    const before = await zoomInfo.textContent();
    await page.click('#zoom-in');
    const afterIn = await zoomInfo.textContent();
    expect(afterIn).not.toBe(before);
    await page.click('#zoom-fit');
    const afterFit = await zoomInfo.textContent();
    expect(afterFit).not.toBe(afterIn);
    await page.click('#zoom-tape');
    expect(await zoomInfo.textContent()).not.toBe(afterFit);
  });

  test('Save PNG downloads a .png', async ({ page }) => {
    await setText(page, 'Save');
    const [download] = await Promise.all([page.waitForEvent('download'), page.click('#save-png')]);
    expect(download.suggestedFilename()).toMatch(/\.png$/i);
  });

  test('the refresh button re-renders', async ({ page }) => {
    await setText(page, 'Refresh');
    await page.click('#refresh-btn');
    await expect.poll(async () => (await preview(page)).ink).toBeGreaterThan(0);
  });

  test('with live preview off only refresh renders', async ({ page }) => {
    await setText(page, 'Hello');
    await page.uncheck('#auto_preview');
    // The click blurs the text box, and that `change` queued one more preview.
    await page.waitForTimeout(400); // longer than the 150 ms preview delay
    await page.fill('#text', 'NoLive');
    await page.waitForTimeout(400);
    const before = await preview(page);
    const after = await previewChange(page, () => page.click('#refresh-btn'));
    expect(before.ink).not.toBe(after.ink);
    await page.check('#auto_preview');
  });

  test('Emoji fill print area does not move plain text', async ({ page }) => {
    const before = await setText(page, 'Hello');
    await page.check('#emoji_print_area');
    await page.waitForTimeout(400); // longer than the 150 ms preview delay
    expect(await preview(page)).toEqual(before);

    // The same with the options the check box sets, and a label with an emoji
    // proves that the option has an effect.
    const pictures = await page.evaluate(
      async (args) => {
        const picture = async (text: string, emoji_print_area: boolean) => {
          const over = { text_to_print: [text], emoji_print_area };
          return (await window.PTLabel.buildLabel({ ...args, ...over })).toDataURL();
        };
        return {
          plainOff: await picture('Hello', false),
          plainOn: await picture('Hello', true),
          emojiOff: await picture('A\u{1F60C}B', false),
          emojiOn: await picture('A\u{1F60C}B', true),
        };
      },
      baseArgs({ fontname: LOADED_FAMILY }),
    );
    expect(pictures.plainOn).toBe(pictures.plainOff);
    expect(pictures.emojiOn).not.toBe(pictures.emojiOff);
  });
});

test('print without a connection is guarded', async ({ page }) => {
  await page.click('#print-btn');
  await expect(page.locator('#status')).toHaveText(/Connect the printer first/);
});

test('a merge image widens the label', async ({ page }) => {
  await loadFixtureFont(page);
  const { before, after } = await page.evaluate(
    async (args) => {
      const L = window.PTLabel;
      const without = await L.buildLabel(args);
      // Create a 40x40 black square PNG data URL.
      const c = document.createElement('canvas');
      c.width = 40;
      c.height = 40;
      const cx = L.ctx2d(c);
      cx.fillStyle = '#fff';
      cx.fillRect(0, 0, 40, 40);
      cx.fillStyle = '#000';
      cx.fillRect(10, 10, 20, 20);
      const merged = await L.buildLabel({ ...args, merge: [c.toDataURL('image/png')] });
      return { before: without.width, after: merged.width };
    },
    baseArgs({ fontname: LOADED_FAMILY, text_to_print: ['Hi'] }),
  );
  expect(after).toBeGreaterThan(before);
});

test('the print flow writes the job to a mocked serial port', async ({ page }) => {
  await loadFixtureFont(page);
  const result = await page.evaluate(
    async (args) => {
      const L = window.PTLabel;
      const P = window.PTPrinter;
      const image = await L.buildLabel(args);
      const padded = L.rasterizeLabel(image, args);
      const d = L.ctx2d(padded).getImageData(0, 0, padded.width, padded.height).data;
      const bytes = new Uint8Array(padded.width * padded.height);
      for (let i = 0; i < bytes.length; i++) bytes[i] = (d[i * 4] ?? 0) < 128 ? 1 : 0;
      function mkStatus(type: number) {
        const s = new Uint8Array(32);
        s.set([0x80, 0x20, 0x42, 0x30], 0);
        s[18] = type;
        s[19] = 0x00;
        return s;
      }
      let reads = 0;
      const written: Uint8Array[] = [];
      const fake = {
        async write(b: Uint8Array) {
          written.push(b.slice());
        },
        async read() {
          reads++;
          return reads === 1 ? mkStatus(0x00) : mkStatus(0x01);
        },
        async resetInputBuffer() {},
      };
      const logs: string[] = [];
      await P.doPrintJob(
        fake,
        args,
        bytes,
        (l) => logs.push(l),
        () => {},
      );
      return { writes: written.length, lastByte: written.at(-1)?.at(-1), logs };
    },
    baseArgs({ fontname: LOADED_FAMILY, text_to_print: ['Print'] }),
  );
  expect(result.writes).toBeGreaterThan(0);
  expect(result.lastByte).toBe(0x1a);
  expect(result.logs.some((l) => /Querying printer status/.test(l))).toBe(true);
  expect(result.logs.some((l) => /Configuring printer/.test(l))).toBe(true);
});
