import { describe, expect, it } from 'vitest';

describe('pixel smoke', () => {
  it('imports loader without throwing', async () => {
    await expect(import('../loader.ts')).resolves.toBeDefined();
  });

  it('imports runtime entry without throwing', async () => {
    await expect(import('../runtime/index.ts')).resolves.toBeDefined();
  });
});
