import { expect, test } from '@playwright/test';

test('plays an authorized WebM on a narrow mobile surface', async ({ page }, testInfo) => {
  await page.setViewportSize({ width: 390, height: 844 });
  await page.goto('/iframe.html?id=sessions-sessionfilebinarypreview--webm-video&viewMode=story');
  const video = page.getByLabel('Video preview');
  await expect(video).toBeVisible();
  await video.evaluate(async (element: HTMLVideoElement) => {
    await element.play();
    await new Promise<void>((resolve, reject) => {
      if (element.currentTime > 0) return resolve();
      element.addEventListener('timeupdate', () => resolve(), { once: true });
      element.addEventListener('error', () => reject(new Error('WebM decode failed')), {
        once: true,
      });
    });
    element.pause();
  });
  expect(await video.evaluate((element: HTMLVideoElement) => element.currentTime)).toBeGreaterThan(
    0
  );
  expect(await video.evaluate((element: HTMLVideoElement) => element.videoWidth)).toBe(160);
  expect(await video.evaluate((element: HTMLVideoElement) => element.playsInline)).toBe(true);
  expect(
    await page.evaluate(() => document.documentElement.scrollWidth - window.innerWidth)
  ).toBeLessThanOrEqual(1);
  await page.screenshot({ path: testInfo.outputPath('mobile-video-preview.png') });
});

test('keeps file actions when media decoding fails', async ({ page }) => {
  await page.goto(
    '/iframe.html?id=sessions-sessionfilebinarypreview--unsupported-video&viewMode=story'
  );
  await expect(page.getByText('Video unavailable')).toBeVisible();
  await expect(page.getByRole('button', { name: 'Share file…', exact: true })).toBeVisible();
  await expect(page.getByRole('button', { name: 'Copy file path', exact: true })).toBeVisible();
  await expect(page.locator('video')).toHaveCount(0);
});

test('plays audio with native controls on a narrow surface', async ({ page }) => {
  await page.setViewportSize({ width: 390, height: 844 });
  await page.goto(
    '/iframe.html?id=sessions-sessionfilebinarypreview--audio-recording&viewMode=story'
  );
  const audio = page.getByLabel('Audio preview');
  await expect(audio).toBeVisible();
  await audio.evaluate(async (element: HTMLAudioElement) => {
    await element.play();
    await new Promise<void>((resolve, reject) => {
      if (element.currentTime > 0) return resolve();
      element.addEventListener('timeupdate', () => resolve(), { once: true });
      element.addEventListener('error', () => reject(new Error('WAV decode failed')), {
        once: true,
      });
    });
    element.pause();
  });
  expect(await audio.evaluate((element: HTMLAudioElement) => element.currentTime)).toBeGreaterThan(
    0
  );
  expect(
    await page.evaluate(() => document.documentElement.scrollWidth - window.innerWidth)
  ).toBeLessThanOrEqual(1);
});

test('shows audio errors with file actions, and unloads hidden audio', async ({ page }) => {
  await page.goto(
    '/iframe.html?id=sessions-sessionfilebinarypreview--unsupported-audio&viewMode=story'
  );
  await expect(page.getByText('Audio unavailable')).toBeVisible();
  await expect(page.getByRole('button', { name: 'Download file', exact: true })).toBeVisible();
  await expect(page.locator('audio')).toHaveCount(0);
  await page.goto(
    '/iframe.html?id=sessions-sessionfilebinarypreview--inactive-audio&viewMode=story'
  );
  await expect(page.locator('#storybook-root')).toBeAttached();
  await expect(page.locator('audio')).toHaveCount(0);
});

for (const width of [390, 1100]) {
  test(`keeps chat media in one responsive card at ${width}px`, async ({ page }) => {
    await page.setViewportSize({ width, height: 844 });
    for (const [story, kind, filename, limit] of [
      ['chat-video', 'video', 'clip.webm', 768],
      ['chat-audio', 'audio', 'recording.wav', 384],
      ['chat-audio-error', 'error', 'broken.wav', 384],
    ] as const) {
      await page.goto(`/iframe.html?id=sessions-sessionfilebinarypreview--${story}&viewMode=story`);
      const card = page.getByTestId('session-media-card');
      await expect(card).toBeVisible();
      const information = card.getByRole('button', { name: filename, exact: true });
      await expect(information).toBeVisible();
      await expect(card.getByRole('button')).toHaveCount(1);
      await expect(page.getByText(filename, { exact: true })).toHaveCount(1);
      const content =
        kind === 'error' ? card.getByTestId('session-file-error-state') : card.locator(kind);
      if (kind === 'error') await expect(content).toContainText('Audio unavailable');
      else
        await expect
          .poll(() => content.evaluate((element: HTMLMediaElement) => element.readyState))
          .toBeGreaterThanOrEqual(1);
      const [cardBox, contentBox, infoBox] = await Promise.all([
        card.boundingBox(),
        content.boundingBox(),
        information.boundingBox(),
      ]);
      expect(cardBox!.width).toBeLessThanOrEqual(limit);
      expect(cardBox!.width).toBeLessThanOrEqual(width);
      expect(Math.abs(contentBox!.x - infoBox!.x)).toBeLessThanOrEqual(1);
      expect(Math.abs(contentBox!.width - infoBox!.width)).toBeLessThanOrEqual(1);
      expect(infoBox!.y - (contentBox!.y + contentBox!.height)).toBeLessThanOrEqual(12);
      if (kind === 'video') {
        const ratio = await content.evaluate(
          (video: HTMLVideoElement) => video.videoWidth / video.videoHeight
        );
        expect(Math.abs(contentBox!.width / contentBox!.height - ratio)).toBeLessThan(0.01);
      }
      expect(
        await page.evaluate(() => document.documentElement.scrollWidth - window.innerWidth)
      ).toBeLessThanOrEqual(1);
    }
  });
}

test('uses dark native audio controls with the dark app theme', async ({ page }) => {
  await page.emulateMedia({ colorScheme: 'dark' });
  await page.goto(
    '/iframe.html?id=sessions-sessionfilebinarypreview--chat-audio-dark&viewMode=story'
  );
  const audio = page.getByLabel('Audio preview');
  await expect(audio).toBeVisible();
  await expect
    .poll(() => page.evaluate(() => document.documentElement.classList.contains('dark')))
    .toBe(true);
  expect(await page.evaluate(() => matchMedia('(prefers-color-scheme: dark)').matches)).toBe(true);
  expect(await audio.evaluate((element) => getComputedStyle(element).colorScheme)).toContain(
    'dark'
  );
});
