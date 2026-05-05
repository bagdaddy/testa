import { expect, test } from '@playwright/test';

test('fixture page loads', async ({ page }) => {
  await page.goto('/');
  await expect(page.locator('h1')).toContainText('Testa pixel fixture');
});
