import { describe, expect, it } from 'vitest';
import { canonicalize } from '../url-canonical.ts';

describe('canonicalize — same-URL detection', () => {
  it('returns identical canonical for query keys reordered', () => {
    const a = canonicalize('https://example.com/foo?b=2&a=1');
    const b = canonicalize('https://example.com/foo?a=1&b=2');
    expect(a).toBe(b);
  });

  it('returns identical canonical when host case differs', () => {
    expect(canonicalize('https://Example.COM/foo')).toBe(canonicalize('https://example.com/foo'));
  });

  it('returns identical canonical when only `_testa_*` params change', () => {
    const a = canonicalize('https://example.com/foo?id=42');
    const b = canonicalize('https://example.com/foo?id=42&_testa_cd=abc&_tu=xyz');
    expect(a).toBe(b);
  });

  it('drops the fragment by default', () => {
    expect(canonicalize('https://example.com/foo#section-1')).toBe('https://example.com/foo');
  });

  it('keeps the fragment when includeHash=true', () => {
    expect(canonicalize('https://example.com/foo#section-1', { includeHash: true })).toBe(
      'https://example.com/foo#section-1',
    );
  });
});

describe('canonicalize — distinct URLs stay distinct', () => {
  it('different paths', () => {
    expect(canonicalize('https://example.com/a')).not.toBe(canonicalize('https://example.com/b'));
  });

  it('different non-_testa query values', () => {
    expect(canonicalize('https://example.com/foo?id=1')).not.toBe(
      canonicalize('https://example.com/foo?id=2'),
    );
  });

  it('different hosts', () => {
    expect(canonicalize('https://a.example.com/foo')).not.toBe(
      canonicalize('https://b.example.com/foo'),
    );
  });

  it('different protocols', () => {
    expect(canonicalize('http://example.com/foo')).not.toBe(
      canonicalize('https://example.com/foo'),
    );
  });
});

describe('canonicalize — robustness', () => {
  it('returns the input string unchanged when URL parsing fails', () => {
    expect(canonicalize('not a url')).toBe('not a url');
  });

  it('preserves the original order of multiple values for the same key', () => {
    // Different value-orderings stay distinct — we don't lose user intent.
    const a = canonicalize('https://example.com/foo?tag=a&tag=b');
    const b = canonicalize('https://example.com/foo?tag=b&tag=a');
    expect(a).not.toBe(b);
    expect(a).toBe('https://example.com/foo?tag=a&tag=b');
  });
});
