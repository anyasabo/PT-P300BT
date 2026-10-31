// Shared by the browser specs. The name does not match *.spec.ts, so Playwright
// does not run it as a spec.

import { test as base, expect, type Page } from '@playwright/test';
import { FONT_PATH } from '../helpers';

export { expect };

// The family that #font-upload gives the fixture font: the file name.
export const LOADED_FAMILY = 'FiraCode-subset';

// Each test also fails on a JavaScript error in the page.
export const test = base.extend<{ pageErrors: string[] }>({
  pageErrors: [
    async ({ page }, use) => {
      const errors: string[] = [];
      page.on('pageerror', (e) => errors.push(String(e)));
      page.on('console', (m) => {
        if (m.type() === 'error') errors.push(m.text());
      });
      await use(errors);
      const real = errors.filter(
        (e) => !/willReadFrequently/.test(e) && !/favicon/.test(e) && !/404/.test(e),
      );
      expect(real, 'no JavaScript errors during the test').toEqual([]);
    },
    { auto: true },
  ],
});

export async function openApp(page: Page): Promise<void> {
  await page.goto('/');
  // Open every collapsible group so all controls are interactable.
  await page.evaluate(() => {
    for (const d of document.querySelectorAll('details')) d.open = true;
  });
}

// Loads the fixture font through the Load font file path. The default font
// (Arial) is not on every machine.
export async function loadFixtureFont(page: Page): Promise<void> {
  await page.setInputFiles('#font-upload', FONT_PATH);
  await expect(page.locator('#font-status')).toHaveText('Loaded FiraCode-subset.ttf');
  await expect(page.locator('#fontname')).toHaveValue(LOADED_FAMILY);
}

export interface Preview {
  w: number;
  h: number;
  ink: number;
  hash: number;
}

export function preview(page: Page): Promise<Preview> {
  return page.evaluate(() => {
    const c = document.querySelector<HTMLCanvasElement>('#preview-canvas');
    const ctx = c?.getContext('2d');
    // getImageData throws on a canvas with no pixels (the empty preview).
    if (!c || !ctx || !c.width || !c.height) return { w: 0, h: 0, ink: 0, hash: 0 };
    const d = ctx.getImageData(0, 0, c.width, c.height).data;
    let ink = 0;
    let hash = 17;
    for (let i = 0; i < d.length; i += 4) {
      const v = d[i] ?? 0;
      if (v < 128) ink++;
      hash = (Math.imul(hash, 31) + v) | 0;
    }
    return { w: c.width, h: c.height, ink, hash };
  });
}

// Runs the action and waits until the preview shows a different picture.
export async function previewChange(page: Page, action: () => Promise<unknown>): Promise<Preview> {
  const before = await preview(page);
  await action();
  await expect.poll(() => preview(page)).not.toEqual(before);
  return preview(page);
}

export function setText(page: Page, text: string): Promise<Preview> {
  return previewChange(page, () => page.fill('#text', text));
}

export function optionValues(page: Page, select: string): Promise<string[]> {
  return page
    .locator(`${select} option`)
    .evaluateAll((options: HTMLOptionElement[]) => options.map((o) => o.value));
}
