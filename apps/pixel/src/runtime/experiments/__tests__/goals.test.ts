import type { GoalConfig } from '@testa-platform/shared-types';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { type AssignedExperiment, createGoalController, urlMatchesGoal } from '../goals.ts';

interface DlWindow {
  dataLayer?: Array<Record<string, unknown>>;
}

function dataLayer(): Array<Record<string, unknown>> {
  return (window as unknown as DlWindow).dataLayer ?? [];
}

beforeEach(() => {
  document.body.innerHTML = '';
  (window as unknown as DlWindow).dataLayer = [];
});

afterEach(() => {
  vi.useRealTimers();
});

describe('urlMatchesGoal', () => {
  it('matches by exact / contains / not_contains / regex', () => {
    expect(urlMatchesGoal('https://x.com/p', 'https://x.com/p', 'exact')).toBe(true);
    expect(urlMatchesGoal('https://x.com/p?a=1', 'https://x.com/p', 'exact')).toBe(false);
    expect(urlMatchesGoal('https://x.com/thanks', '/thanks', 'contains')).toBe(true);
    expect(urlMatchesGoal('https://x.com/home', '/thanks', 'not_contains')).toBe(true);
    expect(urlMatchesGoal('https://x.com/p/42', '/p/\\d+', 'regex')).toBe(true);
    expect(urlMatchesGoal('https://x.com/p', 'checkout', undefined)).toBe(false);
  });

  it('fails closed on a malformed regex', () => {
    expect(urlMatchesGoal('https://x.com', '(', 'regex')).toBe(false);
  });
});

function assigned(goals: GoalConfig[]): AssignedExperiment {
  return { experimentId: 7, variationId: 2, goals };
}

describe('createGoalController — page_view goals', () => {
  it('fires a conversion immediately when the URL matches', () => {
    const track = vi.fn();
    const c = createGoalController({ track });
    const goal: GoalConfig = {
      goal_id: 11,
      name: 'Thanks',
      type: 'page_view',
      match_type: 'contains',
      action: '/thanks',
    };

    c.register([assigned([goal])], 'https://shop.example/thanks');

    expect(track).toHaveBeenCalledWith('conversion', {
      goal_id: 11,
      experiment_id: 7,
      variation_id: 2,
    });
    expect(dataLayer()).toContainEqual({
      event: 'analytica_conversion',
      goalName: 'Thanks',
      goalId: 11,
    });
  });

  it('does not fire when the URL does not match', () => {
    const track = vi.fn();
    const c = createGoalController({ track });
    const goal: GoalConfig = {
      goal_id: 11,
      type: 'page_view',
      match_type: 'contains',
      action: '/thanks',
    };
    c.register([assigned([goal])], 'https://shop.example/home');
    expect(track).not.toHaveBeenCalled();
  });
});

describe('createGoalController — custom goals', () => {
  it('fires only when a matching custom event name is emitted', () => {
    const track = vi.fn();
    const c = createGoalController({ track });
    const goal: GoalConfig = { goal_id: 22, type: 'custom', action: 'demo_booked' };
    c.register([assigned([goal])], 'https://shop.example');

    c.handleCustomEvent('unrelated', {});
    expect(track).not.toHaveBeenCalled();

    c.handleCustomEvent('demo_booked', { plan: 'pro' });
    expect(track).toHaveBeenCalledWith('conversion', {
      goal_id: 22,
      experiment_id: 7,
      variation_id: 2,
      plan: 'pro',
    });
  });

  it('stops matching after teardown', () => {
    const track = vi.fn();
    const c = createGoalController({ track });
    c.register([assigned([{ goal_id: 22, type: 'custom', action: 'x' }])], 'https://s.example');
    c.teardown();
    c.handleCustomEvent('x', {});
    expect(track).not.toHaveBeenCalled();
  });
});

describe('createGoalController — click goals', () => {
  it('attaches to the selector and fires a conversion on click (after setup delay)', () => {
    vi.useFakeTimers();
    const track = vi.fn();
    const c = createGoalController({ track });
    const btn = document.createElement('button');
    btn.className = 'cta';
    document.body.appendChild(btn);

    c.register([assigned([{ goal_id: 33, type: 'click', action: '.cta' }])], 'https://s.example');
    // Listener is wired after the 650ms setup delay.
    vi.advanceTimersByTime(700);
    btn.click();

    expect(track).toHaveBeenCalledWith('conversion', {
      goal_id: 33,
      experiment_id: 7,
      variation_id: 2,
    });
  });

  it('retries for a late-rendered element, then wires it', () => {
    vi.useFakeTimers();
    const track = vi.fn();
    const c = createGoalController({ track });
    c.register(
      [assigned([{ goal_id: 33, type: 'click', action: '.late-cta' }])],
      'https://s.example',
    );

    vi.advanceTimersByTime(700); // setup delay elapses, element absent → schedules retry
    const btn = document.createElement('button');
    btn.className = 'late-cta';
    document.body.appendChild(btn);
    vi.advanceTimersByTime(200); // retry finds it

    btn.click();
    expect(track).toHaveBeenCalledTimes(1);
  });

  it('teardown removes the click listener', () => {
    vi.useFakeTimers();
    const track = vi.fn();
    const c = createGoalController({ track });
    const btn = document.createElement('button');
    btn.className = 'cta';
    document.body.appendChild(btn);
    c.register([assigned([{ goal_id: 33, type: 'click', action: '.cta' }])], 'https://s.example');
    vi.advanceTimersByTime(700);
    c.teardown();
    btn.click();
    expect(track).not.toHaveBeenCalled();
  });
});
