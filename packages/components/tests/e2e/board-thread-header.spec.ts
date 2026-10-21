import { expect, test, type Locator } from '@playwright/test';

async function rightEdge(locator: Locator) {
  const box = (await locator.boundingBox())!;
  return box.x + box.width;
}

// A thread open in the Board side panel, under the panel's tab strip.
const story = '/iframe.html?id=workspace-boards--article-closed&viewMode=story&globals=locale:en';

test('keeps the open button on the panel edge and the location whole at every panel width', async ({
  page,
}) => {
  // 600 is below the small breakpoint, where the header used to stack its parts.
  for (const width of [600, 900, 1160, 1440, 1920]) {
    await page.setViewportSize({ width, height: 800 });
    await page.goto(story);
    const open = page.getByRole('button', { name: 'Open as a full conversation' });
    await expect(open).toBeVisible({ timeout: 60_000 });
    const addPanel = page.getByRole('button', { name: 'Add panel' });
    // The last header control lines up with the strip's last control above it.
    expect(await rightEdge(open)).toBeCloseTo(await rightEdge(addPanel), 0);
    // The header stays one line inside its own height.
    const header = page.getByRole('button', { name: 'Back to threads' }).locator('xpath=../../..');
    const fits = await header.evaluate((element) => element.scrollHeight <= element.clientHeight);
    expect(fits).toBe(true);
    // A short location is not cut while the header has room for it.
    const location = page.getByTitle('devnuc · Lody');
    const clipped = await location.evaluate((element) => element.scrollWidth > element.clientWidth);
    expect(clipped).toBe(false);
  }
});
