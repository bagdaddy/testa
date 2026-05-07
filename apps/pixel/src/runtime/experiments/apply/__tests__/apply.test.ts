import type { VariationChange } from '@testa-platform/shared-types';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { stripScriptTags } from '../html.ts';
import {
  applyAttribute,
  applyCss,
  applyHtml,
  applyJs,
  applyText,
  applyVariation,
} from '../index.ts';

beforeEach(() => {
  document.head.innerHTML = '';
  document.body.innerHTML = '';
});

afterEach(() => {
  document.head.innerHTML = '';
  document.body.innerHTML = '';
});

// ─── CSS ───────────────────────────────────────────────────────────────────

describe('applyCss', () => {
  it('injects a <style> tag with the selector + styles', () => {
    applyCss(100, {
      type: 'css',
      selector: '.buy-button',
      styles: { 'background-color': '#ff6600', color: '#fff' },
    });
    const style = document.querySelector('style[data-testa-css="100"]');
    expect(style).not.toBeNull();
    expect(style?.textContent).toContain('.buy-button');
    expect(style?.textContent).toContain('background-color: #ff6600');
    expect(style?.textContent).toContain('color: #fff');
  });

  it('is idempotent — second apply with same selector overwrites the same tag', () => {
    applyCss(100, { type: 'css', selector: '.foo', styles: { color: 'red' } });
    applyCss(100, { type: 'css', selector: '.foo', styles: { color: 'blue' } });
    const styles = document.querySelectorAll('style[data-testa-css="100"]');
    expect(styles.length).toBe(1);
    expect(styles[0]?.textContent).toContain('color: blue');
    expect(styles[0]?.textContent).not.toContain('color: red');
  });

  it('escapes property names — strips invalid chars from the prop name', () => {
    applyCss(100, {
      type: 'css',
      selector: '.foo',
      // biome-ignore lint/suspicious/noExplicitAny: testing escape behavior
      styles: { 'color}; }malicious{': 'red' } as any,
    });
    const style = document.querySelector('style[data-testa-css="100"]');
    // The malicious `}` and `{` are stripped from the property name.
    // (The literal `{` and `}` wrapping the rule itself remain — they're our own.)
    expect(style?.textContent).toBe('.foo { colormalicious: red; }');
  });

  it('escapes value — strips `{` and `}` to prevent rule break-out', () => {
    applyCss(100, {
      type: 'css',
      selector: '.foo',
      styles: { color: 'red; } body { display: none' },
    });
    const style = document.querySelector('style[data-testa-css="100"]');
    // The malicious value's `{` and `}` are stripped. Only our wrapping
    // `{` and `}` remain (one of each). The browser's CSS parser will
    // see one rule, not two — the malicious `body` selector can't reach
    // the parser as a selector.
    const text = style?.textContent ?? '';
    const openBraces = (text.match(/\{/g) ?? []).length;
    const closeBraces = (text.match(/\}/g) ?? []).length;
    expect(openBraces).toBe(1);
    expect(closeBraces).toBe(1);
  });

  it('different selectors get different style tag ids', () => {
    applyCss(100, { type: 'css', selector: '.foo', styles: { color: 'red' } });
    applyCss(100, { type: 'css', selector: '.bar', styles: { color: 'blue' } });
    expect(document.querySelectorAll('style[data-testa-css="100"]').length).toBe(2);
  });
});

// ─── text ──────────────────────────────────────────────────────────────────

describe('applyText', () => {
  it('replaces textContent on each matching element', () => {
    document.body.innerHTML = '<button class="cta">Old</button><button class="cta">Old</button>';
    applyText({ type: 'text', selector: '.cta', text: 'New' });
    const buttons = document.querySelectorAll('.cta');
    expect(buttons[0]?.textContent).toBe('New');
    expect(buttons[1]?.textContent).toBe('New');
  });

  it('treats user-supplied HTML as text (escapes it)', () => {
    document.body.innerHTML = '<div class="x"></div>';
    applyText({ type: 'text', selector: '.x', text: '<b>bold</b>' });
    const el = document.querySelector('.x');
    expect(el?.textContent).toBe('<b>bold</b>');
    expect(el?.querySelector('b')).toBeNull();
  });

  it('returns a teardown function', () => {
    const teardown = applyText({ type: 'text', selector: '.absent', text: 'x' });
    expect(typeof teardown).toBe('function');
    teardown();
  });
});

// ─── attribute ─────────────────────────────────────────────────────────────

describe('applyAttribute', () => {
  it('sets the attribute on each matching element', () => {
    document.body.innerHTML = '<a class="cta" href="/old">go</a>';
    applyAttribute({ type: 'attribute', selector: '.cta', name: 'href', value: '/new' });
    expect(document.querySelector('.cta')?.getAttribute('href')).toBe('/new');
  });

  it('refuses to set on* event-handler attributes', () => {
    document.body.innerHTML = '<button class="cta">go</button>';
    applyAttribute({
      type: 'attribute',
      selector: '.cta',
      name: 'onclick',
      value: 'alert(1)',
    });
    expect(document.querySelector('.cta')?.getAttribute('onclick')).toBeNull();
  });

  it('refuses srcdoc', () => {
    document.body.innerHTML = '<iframe class="x"></iframe>';
    applyAttribute({
      type: 'attribute',
      selector: '.x',
      name: 'srcdoc',
      value: '<script>alert(1)</script>',
    });
    expect(document.querySelector('.x')?.getAttribute('srcdoc')).toBeNull();
  });
});

// ─── HTML ──────────────────────────────────────────────────────────────────

describe('applyHtml', () => {
  it('replaces innerHTML with the supplied HTML', () => {
    document.body.innerHTML = '<div class="x">old</div>';
    applyHtml({ type: 'html', selector: '.x', html: '<span>new</span>' });
    expect(document.querySelector('.x')?.innerHTML).toBe('<span>new</span>');
  });

  it('strips <script> tags defensively', () => {
    document.body.innerHTML = '<div class="x"></div>';
    applyHtml({
      type: 'html',
      selector: '.x',
      html: 'before<script>window.x = 1</script>after',
    });
    const el = document.querySelector('.x');
    expect(el?.innerHTML).toBe('beforeafter');
    expect((window as unknown as { x?: number }).x).toBeUndefined();
  });

  it('preserves iframe / video tags', () => {
    document.body.innerHTML = '<div class="x"></div>';
    applyHtml({
      type: 'html',
      selector: '.x',
      html: '<iframe src="https://www.youtube.com/embed/abc"></iframe>',
    });
    expect(document.querySelector('.x')?.querySelector('iframe')).not.toBeNull();
  });
});

describe('stripScriptTags', () => {
  it('matches across attributes', () => {
    expect(stripScriptTags('a<script type="text/javascript">x</script>b')).toBe('ab');
  });

  it('is case-insensitive', () => {
    expect(stripScriptTags('a<SCRIPT>x</SCRIPT>b')).toBe('ab');
  });

  it('handles multi-line', () => {
    expect(stripScriptTags('a<script>\nfoo\nbar\n</script>b')).toBe('ab');
  });
});

// ─── JS ────────────────────────────────────────────────────────────────────

describe('applyJs', () => {
  it('evaluates the customer code', () => {
    (window as unknown as { __testaJsTest?: number }).__testaJsTest = 0;
    applyJs({ type: 'js', code: 'window.__testaJsTest = 42;' });
    expect((window as unknown as { __testaJsTest?: number }).__testaJsTest).toBe(42);
  });

  it('catches throws and continues', () => {
    const errSpy = vi.spyOn(console, 'error').mockImplementation(() => {});
    expect(() => applyJs({ type: 'js', code: 'throw new Error("boom");' })).not.toThrow();
    expect(errSpy).toHaveBeenCalled();
    errSpy.mockRestore();
  });

  it('skips empty code', () => {
    expect(() => applyJs({ type: 'js', code: '' })).not.toThrow();
  });
});

// ─── applyVariation orchestrator ──────────────────────────────────────────

describe('applyVariation', () => {
  it('dispatches to all change types in order', () => {
    document.body.innerHTML = '<button class="cta">old</button>';
    const changes: VariationChange[] = [
      { type: 'css', selector: '.cta', styles: { color: 'red' } },
      { type: 'text', selector: '.cta', text: 'new' },
      { type: 'attribute', selector: '.cta', name: 'data-test', value: 'x' },
    ];
    const teardowns = applyVariation(100, changes);

    expect(document.querySelector('style[data-testa-css="100"]')).not.toBeNull();
    expect(document.querySelector('.cta')?.textContent).toBe('new');
    expect(document.querySelector('.cta')?.getAttribute('data-test')).toBe('x');
    expect(teardowns.length).toBeGreaterThanOrEqual(2); // text + attribute
  });

  it('one applier throwing does not abort the rest', () => {
    document.body.innerHTML = '<div class="x">old</div>';
    const errSpy = vi.spyOn(console, 'error').mockImplementation(() => {});
    const changes: VariationChange[] = [
      { type: 'js', code: 'throw new Error("boom");' },
      { type: 'text', selector: '.x', text: 'new' },
    ];
    applyVariation(100, changes);
    expect(document.querySelector('.x')?.textContent).toBe('new');
    errSpy.mockRestore();
  });

  it('redirect changes are no-ops here (Phase 3.10 owns them)', () => {
    document.body.innerHTML = '<div>x</div>';
    expect(() =>
      applyVariation(100, [{ type: 'redirect', from_url: '/a', to_url: '/b' }]),
    ).not.toThrow();
  });
});

// ─── late-arrival via MutationObserver ────────────────────────────────────

describe('eachMatching — late arrival', () => {
  it('applies to elements added after the call', async () => {
    document.body.innerHTML = '<div id="root"></div>';
    applyText({ type: 'text', selector: '.late', text: 'NEW' });

    // Inject a matching element later.
    const el = document.createElement('div');
    el.className = 'late';
    el.textContent = 'OLD';
    document.getElementById('root')?.appendChild(el);

    await new Promise((r) => setTimeout(r, 20));
    expect(document.querySelector('.late')?.textContent).toBe('NEW');
  });
});
