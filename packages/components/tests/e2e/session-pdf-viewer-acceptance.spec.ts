import { mkdir } from 'node:fs/promises';
import { join, resolve } from 'node:path';
import { expect, test } from '@playwright/test';

const capturePhase = process.env.PDF_VIEWER_CAPTURE_PHASE;
const storyUrl =
  process.env.PDF_VIEWER_STORY_URL ??
  '/iframe.html?id=sessions-sessionfilebinarypreview--pdf-document&viewMode=story';
const artifactDirectory = resolve(process.cwd(), '../../artifacts/pdf-viewer-acceptance');

test.use({
  viewport: { width: 1280, height: 800 },
  video: capturePhase ? { mode: 'on', size: { width: 1280, height: 800 } } : 'off',
});

test('PDF viewer acceptance capture', async ({ page }) => {
  await page.goto(storyUrl);

  if (capturePhase === 'before') {
    await expect(page.getByText('The component failed to render properly')).toBeVisible();
  } else {
    await expect(page.getByRole('region', { name: 'PDF viewer' })).toBeVisible();
    const currentPage = page.getByRole('spinbutton', { name: 'Page number' });
    await expect(currentPage).toHaveValue('1');

    await page.getByRole('button', { name: 'Pages sidebar' }).click();
    await page.getByRole('button', { name: 'Go to page 3' }).click();
    await expect(currentPage).toHaveValue('3');

    const pageView = page.locator('.page[data-page-number="3"]');
    const beforeRotation = await pageView.boundingBox();
    await page.getByRole('button', { name: 'Rotate clockwise' }).click();
    await expect(currentPage).toHaveValue('3');
    await expect
      .poll(async () => (await pageView.boundingBox())?.height ?? 0)
      .toBeLessThan(beforeRotation?.height ?? 0);

    await page.getByRole('combobox', { name: 'Zoom level' }).click();
    await page.getByRole('option', { name: 'Fit page' }).click();
    await expect(page.getByRole('combobox', { name: 'Zoom level' })).toContainText('Fit page');
    await page.getByRole('combobox', { name: 'Zoom level' }).click();
    await page.getByRole('option', { name: '125%' }).click();
    await expect(page.getByRole('combobox', { name: 'Zoom level' })).toContainText('125%');

    await page.getByRole('button', { name: 'Search document' }).click();
    await page.getByRole('searchbox', { name: 'Find in document' }).fill('Revenue');
    await expect(page.getByText('1/1')).toBeVisible();
    await expect(currentPage).toHaveValue('2');
    await expect(page.locator('.textLayer .highlight')).toHaveCount(1);
    await page.getByRole('button', { name: 'Close search' }).click();
    await expect(page.getByRole('searchbox', { name: 'Find in document' })).toHaveCount(0);
    await expect(page.locator('.textLayer .highlight')).toHaveCount(0);
  }

  if (capturePhase) {
    await mkdir(artifactDirectory, { recursive: true });
    await page.screenshot({ path: join(artifactDirectory, `${capturePhase}.png`) });
    const video = page.video();
    await page.close();
    await video?.saveAs(join(artifactDirectory, `${capturePhase}.webm`));
  }
});

test('PDF viewer controls remain usable in a narrow file panel', async ({ page }) => {
  await page.setViewportSize({ width: 390, height: 844 });
  await page.goto('/iframe.html?id=sessions-sessionfilebinarypreview--pdf-document&viewMode=story');

  await expect(page.getByRole('region', { name: 'PDF viewer' })).toBeVisible();
  await page.getByRole('button', { name: 'Pages sidebar' }).click();
  await page.getByRole('button', { name: 'Go to page 2' }).click();
  await expect(page.getByRole('spinbutton', { name: 'Page number' })).toHaveValue('2');
  await page.getByRole('button', { name: 'Search document' }).click();
  await expect(page.getByRole('searchbox', { name: 'Find in document' })).toBeVisible();
  expect(
    await page.evaluate(
      () => document.documentElement.scrollWidth - document.documentElement.clientWidth
    )
  ).toBeLessThanOrEqual(1);
});

test('a PDF that loads while its panel is still collapsed draws once the panel opens', async ({
  page,
}) => {
  // The side panel's content is 0 wide while the panel is collapsed or sliding
  // open; the document is usually ready before that ends.
  await page.addInitScript(() => {
    const sheet = new CSSStyleSheet();
    sheet.replaceSync('#storybook-root { width: 0 !important; overflow: hidden !important; }');
    document.adoptedStyleSheets = [sheet];
  });
  await page.goto('/iframe.html?id=sessions-sessionfilebinarypreview--pdf-document&viewMode=story');
  await expect(page.locator('.pdfViewer .page')).toHaveCount(4);

  await page.evaluate(() => {
    document.adoptedStyleSheets = [];
  });

  // Nothing else is touched: no thumbnail toggle, no zoom change.
  const firstPage = page.locator('.page[data-page-number="1"]');
  await expect.poll(async () => (await firstPage.boundingBox())?.width ?? 0).toBeGreaterThan(400);
  await expect(firstPage.locator('canvas')).toHaveCount(1);
  await expect(firstPage.locator('.textLayer')).toContainText('Overview');
  await expect(page.getByRole('combobox', { name: 'Zoom level' })).toContainText('Fit width');
});

for (const story of ['pdf-file-panel', 'pdf-collapsed-file-panel']) {
  test(`PDF fills its file panel and refits after resizing: ${story}`, async ({ page }) => {
    await page.goto(`/iframe.html?id=sessions-sessionfilebinarypreview--${story}&viewMode=story`);
    if (story === 'pdf-collapsed-file-panel') {
      await expect(page.locator('.pdfViewer .page')).toHaveCount(0);
    }
    await page.getByRole('button', { name: 'Open PDF', exact: true }).click();
    const viewer = page.locator('.pdfViewer');
    const firstPage = viewer.locator('.page[data-page-number="1"]');
    await expect
      .poll(() => viewer.evaluate((element) => element.parentElement!.clientHeight))
      .toBeGreaterThan(400);
    await expect(firstPage.locator('canvas[role="presentation"]')).toBeVisible();
    await expect(firstPage.locator('.textLayer')).toContainText('Overview');
    await expect(page.getByRole('combobox', { name: 'Zoom level' })).toContainText('Fit width');
    const fittedWidth = (await firstPage.boundingBox())!.width;
    const handle = (await page.getByRole('separator').boundingBox())!;
    await page.mouse.move(handle.x + handle.width / 2, handle.y + handle.height / 2);
    await page.mouse.down();
    await page.mouse.move(handle.x - 120, handle.y + handle.height / 2, { steps: 8 });
    await page.mouse.up();
    await expect
      .poll(async () => (await firstPage.boundingBox())!.width)
      .toBeGreaterThan(fittedWidth + 80);
    await expect(firstPage.locator('.textLayer')).toContainText('Overview');
    await page.getByRole('combobox', { name: 'Zoom level' }).click();
    await page.getByRole('option', { name: '50%', exact: true }).click();
    const fixedWidth = (await firstPage.boundingBox())!.width;
    const resizedHandle = (await page.getByRole('separator').boundingBox())!;
    await page.mouse.move(resizedHandle.x, resizedHandle.y + resizedHandle.height / 2);
    await page.mouse.down();
    await page.mouse.move(resizedHandle.x + 100, resizedHandle.y + resizedHandle.height / 2, {
      steps: 8,
    });
    await page.mouse.up();
    await expect(page.getByRole('combobox', { name: 'Zoom level' })).toContainText('50%');
    expect((await firstPage.boundingBox())!.width).toBeCloseTo(fixedWidth, 0);
  });
}
