/*
 * The unsupported-browser path. WebKit (the Safari engine) has no Web Serial
 * API, so it shows the banner and the preview still works.
 */

import { expect, openApp, preview, test } from './app-test';

test.skip(({ browserName }) => browserName !== 'webkit', 'needs a browser without Web Serial');

test('an unsupported browser gets the banner and a working preview', async ({ page }) => {
  await openApp(page);
  await expect(page.locator('#support-badge')).toHaveText(/unavailable/i);
  await expect(page.locator('#support-banner')).toBeVisible();
  await expect(page.locator('#support-banner-text')).toContainText('Chrome or Edge');

  await page.fill('#text', 'NoSerial');
  await expect.poll(async () => (await preview(page)).ink).toBeGreaterThan(0);
});
