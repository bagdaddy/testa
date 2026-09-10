import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { createGoalController } from '../controller.ts';
import { emitLegacyConversion, resetConversionGuard } from '../convert.ts';
import {
  installGoalGlobals,
  pushEvent,
  registerGoalController,
  resetGoalRegistry,
} from '../registry.ts';

describe('emitLegacyConversion', () => {
  const fetchMock = vi.fn().mockResolvedValue(new Response(null, { status: 204 }));

  beforeEach(() => {
    resetConversionGuard();
    fetchMock.mockClear();
    vi.stubGlobal('fetch', fetchMock);
  });

  afterEach(() => {
    vi.unstubAllGlobals();
  });

  it('POSTs the legacy /api/leads/convert payload', async () => {
    await emitLegacyConversion('https://new.testa-soft.tech/', {
      goal_id: 7,
      action: '/quiz',
      lead_uuid: 'u-1',
      variation: 1,
    });

    expect(fetchMock).toHaveBeenCalledTimes(1);
    const [url, init] = fetchMock.mock.calls[0] as [string, RequestInit];
    expect(url).toBe('https://new.testa-soft.tech/api/leads/convert');
    expect(init.method).toBe('POST');
    expect(init.keepalive).toBe(true);
    expect(JSON.parse(init.body as string)).toEqual({
      goal_id: 7,
      action: '/quiz',
      lead_uuid: 'u-1',
      variation: 1,
      data: {},
    });
  });

  it('dedups per goal_id within one page load', async () => {
    const payload = { goal_id: 7, action: '/quiz', lead_uuid: 'u-1', variation: 1 };
    await emitLegacyConversion('https://t.example', payload);
    await emitLegacyConversion('https://t.example', payload);
    expect(fetchMock).toHaveBeenCalledTimes(1);
  });

  it('skips when there is no visitor uuid', async () => {
    await emitLegacyConversion('https://t.example', {
      goal_id: 8,
      action: 'x',
      lead_uuid: '',
      variation: 0,
    });
    expect(fetchMock).not.toHaveBeenCalled();
  });

  it('never rejects on network failure', async () => {
    fetchMock.mockRejectedValueOnce(new Error('offline'));
    await expect(
      emitLegacyConversion('https://t.example', {
        goal_id: 9,
        action: 'x',
        lead_uuid: 'u-1',
        variation: 0,
      }),
    ).resolves.toBeUndefined();
  });
});

describe('goal registry + pushEvent', () => {
  beforeEach(() => {
    resetGoalRegistry();
  });

  it('routes pushEvent to live controllers and stops after unregister', () => {
    const track = vi.fn();
    const controller = createGoalController({ track });
    controller.register(
      [
        {
          experimentId: 1,
          variationId: 1,
          goals: [{ goal_id: 5, type: 'custom', action: 'signup' }],
        },
      ],
      'https://t.example',
    );

    const unregister = registerGoalController(controller);
    pushEvent('signup', { plan: 'pro' });
    expect(track).toHaveBeenCalledTimes(1);

    unregister();
    pushEvent('signup', {});
    expect(track).toHaveBeenCalledTimes(1);
  });

  it('installGoalGlobals exposes window.testa.pushEvent + window.Analytica.pushEvent without clobbering', () => {
    // Indexed access, so assigning here does not narrow the read back below —
    // `installGoalGlobals` mutates these and TypeScript cannot see that.
    const w = window as unknown as Record<
      string,
      { pushEvent?: unknown; spa?: number } | undefined
    >;
    w.testa = undefined;
    w.Analytica = { spa: 1, pushEvent: 'existing' };

    installGoalGlobals();

    // Read back through a FRESH reference. Assigning `w.testa = undefined`
    // above narrows that binding to `undefined` for the rest of the block, so
    // reading through it makes the property access `never` — even though
    // `installGoalGlobals` has since populated it.
    const after = window as unknown as Record<
      string,
      { pushEvent?: unknown; spa?: number } | undefined
    >;
    expect(typeof after.testa?.pushEvent).toBe('function');
    // A pre-existing pushEvent (legacy pixel) is left untouched.
    expect(after.Analytica?.pushEvent).toBe('existing');
    expect(after.Analytica?.spa).toBe(1);
  });
});
