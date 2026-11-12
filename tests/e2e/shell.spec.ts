import { expect, test } from '@playwright/test';

test('@smoke Settings hash route survives reload', async ({ page }) => {
  await page.goto('/tennis-stats/#/settings');
  await expect(page.getByRole('heading', { name: 'Settings' })).toBeVisible();
  await page.reload();
  await expect(page).toHaveURL(/#\/settings$/);
  await expect(page.getByRole('heading', { name: 'Settings' })).toBeVisible();
});
