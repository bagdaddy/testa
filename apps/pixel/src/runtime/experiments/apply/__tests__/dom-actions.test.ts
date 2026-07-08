/**
 * Tests for the DOM variation actions ported from legacy 3.3.3 `handleCopyFields`:
 * hide / append / prepend / move.
 */

import type { VariationChange } from '@testa-platform/shared-types';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { applyAppend, applyHide, applyMove, applyPrepend, applyVariation } from '../index.ts';

beforeEach(() => {
  document.head.innerHTML = '';
  document.body.innerHTML = '';
});

afterEach(() => {
  document.head.innerHTML = '';
  document.body.innerHTML = '';
});

// ─── hide ────────────────────────────────────────────────────────────────────

describe('applyHide', () => {
  it('sets display:none on the matching element', () => {
    document.body.innerHTML = '<div class="promo">x</div>';
    applyHide({ type: 'hide', selector: '.promo' });
    expect((document.querySelector('.promo') as HTMLElement).style.display).toBe('none');
  });

  it('hides every matching element', () => {
    document.body.innerHTML = '<span class="p">a</span><span class="p">b</span>';
    applyHide({ type: 'hide', selector: '.p' });
    const els = document.querySelectorAll<HTMLElement>('.p');
    expect(els[0]?.style.display).toBe('none');
    expect(els[1]?.style.display).toBe('none');
  });

  it('returns a teardown even when nothing matches (watches for late renders)', () => {
    const teardown = applyHide({ type: 'hide', selector: '.absent' });
    expect(typeof teardown).toBe('function');
    teardown();
  });

  it('hides elements that render after apply (SPA / late render)', () => {
    const teardown = applyHide({ type: 'hide', selector: '.late' });
    const el = document.createElement('div');
    el.className = 'late';
    document.body.appendChild(el);
    // MutationObserver is async; assert via a microtask/macrotask tick.
    return new Promise<void>((resolve) => {
      setTimeout(() => {
        expect(el.style.display).toBe('none');
        teardown();
        resolve();
      }, 0);
    });
  });
});

// ─── append ──────────────────────────────────────────────────────────────────

describe('applyAppend', () => {
  it('inserts HTML at the end of the element (beforeend)', () => {
    document.body.innerHTML = '<div class="box"><span class="first">1</span></div>';
    applyAppend({ type: 'append', selector: '.box', html: '<span class="added">2</span>' });
    const box = document.querySelector('.box');
    expect(box?.lastElementChild?.classList.contains('added')).toBe(true);
    expect(box?.firstElementChild?.classList.contains('first')).toBe(true);
  });

  it('appends into every matching element', () => {
    document.body.innerHTML = '<div class="box"></div><div class="box"></div>';
    applyAppend({ type: 'append', selector: '.box', html: '<i class="mark"></i>' });
    expect(document.querySelectorAll('.box .mark').length).toBe(2);
  });

  it('strips <script> tags defensively', () => {
    document.body.innerHTML = '<div class="box"></div>';
    applyAppend({
      type: 'append',
      selector: '.box',
      html: 'a<script>window.__evil = 1</script>b',
    });
    expect(document.querySelector('.box')?.innerHTML).toBe('ab');
    expect((window as unknown as { __evil?: number }).__evil).toBeUndefined();
  });

  it('returns a teardown function', () => {
    const teardown = applyAppend({ type: 'append', selector: '.absent', html: 'x' });
    expect(typeof teardown).toBe('function');
    teardown();
  });
});

// ─── prepend ─────────────────────────────────────────────────────────────────

describe('applyPrepend', () => {
  it('inserts HTML at the start of the element (afterbegin)', () => {
    document.body.innerHTML = '<div class="box"><span class="last">1</span></div>';
    applyPrepend({ type: 'prepend', selector: '.box', html: '<span class="added">0</span>' });
    const box = document.querySelector('.box');
    expect(box?.firstElementChild?.classList.contains('added')).toBe(true);
    expect(box?.lastElementChild?.classList.contains('last')).toBe(true);
  });

  it('prepends into every matching element', () => {
    document.body.innerHTML = '<div class="box"><b>x</b></div><div class="box"><b>y</b></div>';
    applyPrepend({ type: 'prepend', selector: '.box', html: '<i class="mark"></i>' });
    const boxes = document.querySelectorAll('.box');
    expect(boxes[0]?.firstElementChild?.classList.contains('mark')).toBe(true);
    expect(boxes[1]?.firstElementChild?.classList.contains('mark')).toBe(true);
  });
});

// ─── move ────────────────────────────────────────────────────────────────────

describe('applyMove', () => {
  it('relocates the element to the end of the target (position append)', () => {
    document.body.innerHTML =
      '<div id="src"><p class="movable">m</p></div>' +
      '<div id="dst"><span class="pre">p</span></div>';
    applyMove({ type: 'move', selector: '.movable', target: '#dst', position: 'append' });
    expect(document.querySelector('#src')?.querySelector('.movable')).toBeNull();
    const dst = document.querySelector('#dst');
    expect(dst?.lastElementChild?.classList.contains('movable')).toBe(true);
    expect(dst?.firstElementChild?.classList.contains('pre')).toBe(true);
  });

  it('relocates the element to the start of the target (position prepend)', () => {
    document.body.innerHTML =
      '<div id="src"><p class="movable">m</p></div>' +
      '<div id="dst"><span class="post">p</span></div>';
    applyMove({ type: 'move', selector: '.movable', target: '#dst', position: 'prepend' });
    const dst = document.querySelector('#dst');
    expect(dst?.firstElementChild?.classList.contains('movable')).toBe(true);
    expect(dst?.lastElementChild?.classList.contains('post')).toBe(true);
  });

  it('is a no-op when the target is missing', () => {
    document.body.innerHTML = '<div id="src"><p class="movable">m</p></div>';
    applyMove({ type: 'move', selector: '.movable', target: '#nope', position: 'append' });
    // Element stays where it was.
    expect(document.querySelector('#src')?.querySelector('.movable')).not.toBeNull();
  });

  it('moves every matching element under the target', () => {
    document.body.innerHTML = '<p class="m">a</p><p class="m">b</p><div id="dst"></div>';
    applyMove({ type: 'move', selector: '.m', target: '#dst', position: 'append' });
    expect(document.querySelectorAll('#dst .m').length).toBe(2);
  });

  it('returns a teardown function', () => {
    const teardown = applyMove({
      type: 'move',
      selector: '.absent',
      target: '#dst',
      position: 'append',
    });
    expect(typeof teardown).toBe('function');
    teardown();
  });
});

// ─── orchestrator wiring ─────────────────────────────────────────────────────

describe('applyVariation — new DOM actions', () => {
  it('dispatches hide / append / prepend / move through the switch', () => {
    document.body.innerHTML =
      '<div class="hideme">x</div>' +
      '<div class="box"></div>' +
      '<p class="mov">m</p><div id="dst"></div>';
    const changes: VariationChange[] = [
      { type: 'hide', selector: '.hideme' },
      { type: 'append', selector: '.box', html: '<i class="a"></i>' },
      { type: 'prepend', selector: '.box', html: '<i class="p"></i>' },
      { type: 'move', selector: '.mov', target: '#dst', position: 'append' },
    ];
    const teardowns = applyVariation(200, changes);

    expect((document.querySelector('.hideme') as HTMLElement).style.display).toBe('none');
    const box = document.querySelector('.box');
    expect(box?.firstElementChild?.classList.contains('p')).toBe(true);
    expect(box?.lastElementChild?.classList.contains('a')).toBe(true);
    expect(document.querySelector('#dst .mov')).not.toBeNull();
    // hide + append + prepend + move all watch the DOM → 4 teardowns.
    expect(teardowns.length).toBe(4);
  });
});
