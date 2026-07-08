import { describe, expect, it } from 'vitest';
import {
  type AstNode,
  type CustomJsContext,
  type IdentifierNode,
  type LiteralNode,
  type MemberExpressionNode,
  evaluateCustomJs,
} from '../custom-js.ts';

// ─── AST builders ────────────────────────────────────────────────────────────

const lit = (value: string | number | boolean | null): LiteralNode => ({ type: 'Literal', value });
const id = (name: string): IdentifierNode => ({ type: 'Identifier', name });

/** Build a dotted member chain, e.g. member('visitor', 'dataLayer', 'order_count'). */
function member(root: string, ...path: string[]): MemberExpressionNode {
  let object: AstNode = id(root);
  for (const key of path) {
    object = { type: 'MemberExpression', object, property: id(key) };
  }
  return object as MemberExpressionNode;
}

function ctx(overrides?: Partial<CustomJsContext>): CustomJsContext {
  return {
    visitor: {
      dataLayer: { order_count: '5', tags: ['vip', 'newsletter'], email: 'a@shop.com' },
      isReturning: true,
    },
    page: { path: '/checkout' },
    session: { count: 3 },
    ...overrides,
  };
}

// ─── happy path ──────────────────────────────────────────────────────────────

describe('evaluateCustomJs — evaluation', () => {
  it('Number(visitor.dataLayer.order_count) > 3', () => {
    const ast: AstNode = {
      type: 'BinaryExpression',
      operator: '>',
      left: {
        type: 'CallExpression',
        callee: id('Number'),
        arguments: [member('visitor', 'dataLayer', 'order_count')],
      },
      right: lit(3),
    };
    expect(evaluateCustomJs(ast, ctx())).toBe(true);
    expect(evaluateCustomJs(ast, ctx({ visitor: { dataLayer: { order_count: '2' } } }))).toBe(
      false,
    );
  });

  it('reads a member value and coerces truthiness', () => {
    expect(evaluateCustomJs(member('visitor', 'isReturning'), ctx())).toBe(true);
  });

  it('missing member reads as undefined (safe navigation) → false', () => {
    expect(evaluateCustomJs(member('visitor', 'dataLayer', 'nope'), ctx())).toBe(false);
  });

  it('equality operators', () => {
    const eq: AstNode = {
      type: 'BinaryExpression',
      operator: '===',
      left: member('page', 'path'),
      right: lit('/checkout'),
    };
    const neq: AstNode = {
      type: 'BinaryExpression',
      operator: '!==',
      left: member('page', 'path'),
      right: lit('/cart'),
    };
    expect(evaluateCustomJs(eq, ctx())).toBe(true);
    expect(evaluateCustomJs(neq, ctx())).toBe(true);
  });

  it('arithmetic + comparison', () => {
    const ast: AstNode = {
      type: 'BinaryExpression',
      operator: '<=',
      left: {
        type: 'BinaryExpression',
        operator: '+',
        left: member('session', 'count'),
        right: lit(1),
      },
      right: lit(4),
    };
    expect(evaluateCustomJs(ast, ctx())).toBe(true);
  });

  it('logical && / || short-circuit', () => {
    const and: AstNode = {
      type: 'LogicalExpression',
      operator: '&&',
      left: member('visitor', 'isReturning'),
      right: lit(true),
    };
    const or: AstNode = {
      type: 'LogicalExpression',
      operator: '||',
      left: lit(false),
      right: member('visitor', 'isReturning'),
    };
    expect(evaluateCustomJs(and, ctx())).toBe(true);
    expect(evaluateCustomJs(or, ctx())).toBe(true);
  });

  it('unary ! and ternary', () => {
    const notReturning: AstNode = {
      type: 'UnaryExpression',
      operator: '!',
      argument: member('visitor', 'isReturning'),
    };
    expect(evaluateCustomJs(notReturning, ctx())).toBe(false);
    const ternary: AstNode = {
      type: 'ConditionalExpression',
      test: member('visitor', 'isReturning'),
      consequent: lit(true),
      alternate: lit(false),
    };
    expect(evaluateCustomJs(ternary, ctx())).toBe(true);
  });

  it('String()/Boolean() global calls', () => {
    const str: AstNode = {
      type: 'BinaryExpression',
      operator: '===',
      left: {
        type: 'CallExpression',
        callee: id('String'),
        arguments: [member('session', 'count')],
      },
      right: lit('3'),
    };
    expect(evaluateCustomJs(str, ctx())).toBe(true);
    const bool: AstNode = { type: 'CallExpression', callee: id('Boolean'), arguments: [lit(0)] };
    expect(evaluateCustomJs(bool, ctx())).toBe(false);
  });

  it('string includes / startsWith / endsWith', () => {
    const includes: AstNode = {
      type: 'CallExpression',
      callee: {
        type: 'MemberExpression',
        object: member('visitor', 'dataLayer', 'email'),
        property: id('includes'),
      },
      arguments: [lit('@shop')],
    };
    const starts: AstNode = {
      type: 'CallExpression',
      callee: {
        type: 'MemberExpression',
        object: member('visitor', 'dataLayer', 'email'),
        property: id('startsWith'),
      },
      arguments: [lit('a@')],
    };
    const ends: AstNode = {
      type: 'CallExpression',
      callee: {
        type: 'MemberExpression',
        object: member('visitor', 'dataLayer', 'email'),
        property: id('endsWith'),
      },
      arguments: [lit('.com')],
    };
    expect(evaluateCustomJs(includes, ctx())).toBe(true);
    expect(evaluateCustomJs(starts, ctx())).toBe(true);
    expect(evaluateCustomJs(ends, ctx())).toBe(true);
  });

  it('array includes', () => {
    const ast: AstNode = {
      type: 'CallExpression',
      callee: {
        type: 'MemberExpression',
        object: member('visitor', 'dataLayer', 'tags'),
        property: id('includes'),
      },
      arguments: [lit('vip')],
    };
    expect(evaluateCustomJs(ast, ctx())).toBe(true);
  });

  it('Array.isArray and Date.now', () => {
    const isArr: AstNode = {
      type: 'CallExpression',
      callee: { type: 'MemberExpression', object: id('Array'), property: id('isArray') },
      arguments: [member('visitor', 'dataLayer', 'tags')],
    };
    expect(evaluateCustomJs(isArr, ctx())).toBe(true);
    const dateNow: AstNode = {
      type: 'BinaryExpression',
      operator: '>',
      left: {
        type: 'CallExpression',
        callee: { type: 'MemberExpression', object: id('Date'), property: id('now') },
        arguments: [],
      },
      right: lit(0),
    };
    expect(evaluateCustomJs(dateNow, ctx())).toBe(true);
  });
});

// ─── rejections ──────────────────────────────────────────────────────────────

describe('evaluateCustomJs — rejects disallowed constructs', () => {
  it('throws on window access', () => {
    const ast: AstNode = {
      type: 'MemberExpression',
      object: id('window'),
      property: id('location'),
    };
    expect(() => evaluateCustomJs(ast, ctx())).toThrow(/window.*not allowed/i);
  });

  it('throws on document access', () => {
    const ast: AstNode = {
      type: 'MemberExpression',
      object: id('document'),
      property: id('cookie'),
    };
    expect(() => evaluateCustomJs(ast, ctx())).toThrow(/document.*not allowed/i);
  });

  it('throws on eval() call', () => {
    const ast: AstNode = { type: 'CallExpression', callee: id('eval'), arguments: [lit('1')] };
    expect(() => evaluateCustomJs(ast, ctx())).toThrow(/eval.*not allowed/i);
  });

  it('throws on Function() call', () => {
    const ast: AstNode = {
      type: 'CallExpression',
      callee: id('Function'),
      arguments: [lit('return 1')],
    };
    expect(() => evaluateCustomJs(ast, ctx())).toThrow(/Function.*not allowed/i);
  });

  it('throws on any assignment node', () => {
    const ast = {
      type: 'AssignmentExpression',
      operator: '=',
      left: id('x'),
      right: lit(1),
    } as unknown as AstNode;
    expect(() => evaluateCustomJs(ast, ctx())).toThrow(
      /Unsupported node type: AssignmentExpression/,
    );
  });

  it('throws on a non-whitelisted method call', () => {
    const ast: AstNode = {
      type: 'CallExpression',
      callee: {
        type: 'MemberExpression',
        object: member('visitor', 'dataLayer', 'email'),
        property: id('toUpperCase'),
      },
      arguments: [],
    };
    expect(() => evaluateCustomJs(ast, ctx())).toThrow(/toUpperCase.*not allowed/i);
  });

  it('throws on forbidden property access (__proto__)', () => {
    const ast: AstNode = {
      type: 'MemberExpression',
      object: member('visitor', 'dataLayer'),
      property: id('__proto__'),
    };
    expect(() => evaluateCustomJs(ast, ctx())).toThrow(/__proto__.*not allowed/i);
  });

  it('throws when member depth exceeds the max', () => {
    const ast = member('visitor', 'a', 'b', 'c', 'd', 'e', 'f');
    expect(() => evaluateCustomJs(ast, ctx())).toThrow(/max depth/i);
  });

  it('throws on a bare context-root identifier used as a value', () => {
    const ast: AstNode = { type: 'CallExpression', callee: id('visitor'), arguments: [] };
    expect(() => evaluateCustomJs(ast, ctx())).toThrow(/visitor.*not allowed/i);
  });
});
