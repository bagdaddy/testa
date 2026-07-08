/**
 * Sandboxed custom-JS audience evaluator (task 3.7).
 *
 * Customers can express a `visitor.custom` audience as a small JS
 * expression (e.g. `Number(visitor.dataLayer.order_count) > 3`). Crobot
 * parses that expression to an AST at config-publish time and ships the
 * AST (NOT the source string) to the pixel. This module walks that AST
 * against a fixed injected context — no `eval`, no `Function`, no access
 * to `window`/`document`/globals beyond a tiny whitelist.
 *
 * Anything outside the allow-list throws a descriptive `Error`. Callers
 * are expected to catch and fail-closed (exclude the visitor).
 */

// ─── AST node types ──────────────────────────────────────────────────────────

export interface LiteralNode {
  type: 'Literal';
  value: string | number | boolean | null;
}

export interface IdentifierNode {
  type: 'Identifier';
  name: string;
}

export interface MemberExpressionNode {
  type: 'MemberExpression';
  object: AstNode;
  property: IdentifierNode | LiteralNode;
  /** `true` for `a[b]`, `false`/absent for `a.b`. */
  computed?: boolean;
}

export type BinaryOperator = '===' | '!==' | '<' | '<=' | '>' | '>=' | '+' | '-' | '*' | '/' | '%';

export interface BinaryExpressionNode {
  type: 'BinaryExpression';
  operator: BinaryOperator;
  left: AstNode;
  right: AstNode;
}

export interface LogicalExpressionNode {
  type: 'LogicalExpression';
  operator: '&&' | '||';
  left: AstNode;
  right: AstNode;
}

export interface UnaryExpressionNode {
  type: 'UnaryExpression';
  operator: '!';
  argument: AstNode;
}

export interface ConditionalExpressionNode {
  type: 'ConditionalExpression';
  test: AstNode;
  consequent: AstNode;
  alternate: AstNode;
}

export interface CallExpressionNode {
  type: 'CallExpression';
  callee: AstNode;
  arguments: AstNode[];
}

export type AstNode =
  | LiteralNode
  | IdentifierNode
  | MemberExpressionNode
  | BinaryExpressionNode
  | LogicalExpressionNode
  | UnaryExpressionNode
  | ConditionalExpressionNode
  | CallExpressionNode;

// ─── injected context ────────────────────────────────────────────────────────

export interface CustomJsContext {
  visitor: Record<string, unknown>;
  page: Record<string, unknown>;
  session: Record<string, unknown>;
}

// ─── configuration ───────────────────────────────────────────────────────────

const MAX_MEMBER_DEPTH = 5;

/** Root identifiers that resolve to injected context objects. */
const CONTEXT_ROOTS = new Set(['visitor', 'page', 'session']);

/** Static namespaces usable only as a call target (`Array.isArray`, `Date.now`).
 * The `String`/`Number`/`Boolean` global functions are whitelisted by the
 * `callGlobalFunction` switch, so they need no separate identifier set here. */
const GLOBAL_NAMESPACE_IDENTIFIERS = new Set(['Array', 'Date']);

/** Instance-method names callable on evaluated receivers. */
const INSTANCE_METHODS = new Set(['includes', 'startsWith', 'endsWith', 'test']);

/** Property names that must never be read (prototype-pollution guards). */
const FORBIDDEN_PROPERTIES = new Set(['__proto__', 'prototype', 'constructor']);

// ─── entry point ─────────────────────────────────────────────────────────────

/**
 * Evaluate a pre-parsed custom-JS AST against the injected context.
 * Result is coerced to boolean. Throws on any disallowed construct.
 */
export function evaluateCustomJs(ast: AstNode, ctx: CustomJsContext): boolean {
  return Boolean(evaluateNode(ast, ctx, 0));
}

// ─── walker ──────────────────────────────────────────────────────────────────

function evaluateNode(node: AstNode, ctx: CustomJsContext, memberDepth: number): unknown {
  switch (node.type) {
    case 'Literal':
      return node.value;
    case 'Identifier':
      return resolveIdentifier(node);
    case 'MemberExpression':
      return evaluateMember(node, ctx, memberDepth);
    case 'UnaryExpression':
      return !evaluateNode(node.argument, ctx, memberDepth);
    case 'BinaryExpression':
      return evaluateBinary(node, ctx, memberDepth);
    case 'LogicalExpression':
      return evaluateLogical(node, ctx, memberDepth);
    case 'ConditionalExpression':
      return evaluateNode(node.test, ctx, memberDepth)
        ? evaluateNode(node.consequent, ctx, memberDepth)
        : evaluateNode(node.alternate, ctx, memberDepth);
    case 'CallExpression':
      return evaluateCall(node, ctx, memberDepth);
    default:
      throw unsupported(node);
  }
}

function resolveIdentifier(node: IdentifierNode): unknown {
  if (CONTEXT_ROOTS.has(node.name)) {
    // Actual value is injected via the context; resolved by evaluateMember's
    // caller. A bare context root evaluates to its object here is not needed
    // because members short-circuit, but support it for completeness.
    throw new Error(
      `Identifier '${node.name}' can only be used as part of a member access (e.g. ${node.name}.field)`,
    );
  }
  throw new Error(`Identifier '${node.name}' is not allowed`);
}

function evaluateMember(
  node: MemberExpressionNode,
  ctx: CustomJsContext,
  memberDepth: number,
): unknown {
  const nextDepth = memberDepth + 1;
  if (nextDepth > MAX_MEMBER_DEPTH) {
    throw new Error(`Member expression exceeds max depth of ${MAX_MEMBER_DEPTH}`);
  }

  const obj = resolveMemberObject(node.object, ctx, nextDepth);
  const key = memberPropertyName(node, ctx, nextDepth);

  if (FORBIDDEN_PROPERTIES.has(key)) {
    throw new Error(`Access to property '${key}' is not allowed`);
  }

  if (obj === null || obj === undefined) {
    // Safe navigation: reading through missing data yields `undefined`
    // rather than throwing, matching audience "fact absent" semantics.
    return undefined;
  }

  return (obj as Record<string, unknown>)[key];
}

/**
 * Resolve the object side of a member access. A context-root identifier
 * (`visitor`/`page`/`session`) resolves to its injected object here — this
 * is the only place a bare root identifier is legal.
 */
function resolveMemberObject(node: AstNode, ctx: CustomJsContext, memberDepth: number): unknown {
  if (node.type === 'Identifier' && CONTEXT_ROOTS.has(node.name)) {
    return ctx[node.name as keyof CustomJsContext];
  }
  return evaluateNode(node, ctx, memberDepth);
}

function memberPropertyName(
  node: MemberExpressionNode,
  ctx: CustomJsContext,
  memberDepth: number,
): string {
  if (node.computed) {
    const computed = evaluateNode(node.property, ctx, memberDepth);
    if (typeof computed !== 'string' && typeof computed !== 'number') {
      throw new Error('Computed member property must resolve to a string or number');
    }
    return String(computed);
  }
  if (node.property.type === 'Identifier') {
    return node.property.name;
  }
  // Non-computed with a Literal property is unusual but harmless.
  return String(node.property.value);
}

function evaluateBinary(
  node: BinaryExpressionNode,
  ctx: CustomJsContext,
  memberDepth: number,
): unknown {
  const left = evaluateNode(node.left, ctx, memberDepth);
  const right = evaluateNode(node.right, ctx, memberDepth);
  return applyBinary(node.operator, left, right);
}

function applyBinary(operator: BinaryOperator, left: unknown, right: unknown): unknown {
  switch (operator) {
    case '===':
      return left === right;
    case '!==':
      return left !== right;
    case '<':
      return (left as number) < (right as number);
    case '<=':
      return (left as number) <= (right as number);
    case '>':
      return (left as number) > (right as number);
    case '>=':
      return (left as number) >= (right as number);
    case '+':
      // Allow numeric add and string concat (mirrors JS `+`).
      return (left as number) + (right as number);
    case '-':
      return (left as number) - (right as number);
    case '*':
      return (left as number) * (right as number);
    case '/':
      return (left as number) / (right as number);
    case '%':
      return (left as number) % (right as number);
    default:
      throw new Error(`Unsupported binary operator: ${String(operator)}`);
  }
}

function evaluateLogical(
  node: LogicalExpressionNode,
  ctx: CustomJsContext,
  memberDepth: number,
): unknown {
  const left = evaluateNode(node.left, ctx, memberDepth);
  if (node.operator === '&&') {
    return left ? evaluateNode(node.right, ctx, memberDepth) : left;
  }
  return left ? left : evaluateNode(node.right, ctx, memberDepth);
}

// ─── calls ───────────────────────────────────────────────────────────────────

function evaluateCall(
  node: CallExpressionNode,
  ctx: CustomJsContext,
  memberDepth: number,
): unknown {
  const args = node.arguments.map((arg) => evaluateNode(arg, ctx, memberDepth));
  const callee = node.callee;

  if (callee.type === 'Identifier') {
    return callGlobalFunction(callee.name, args);
  }

  if (callee.type === 'MemberExpression') {
    return callMemberFunction(callee, args, ctx, memberDepth);
  }

  throw new Error('Only whitelisted function and method calls are allowed');
}

/** `String(x)` / `Number(x)` / `Boolean(x)`. */
function callGlobalFunction(name: string, args: readonly unknown[]): unknown {
  switch (name) {
    case 'String':
      return String(args[0]);
    case 'Number':
      return Number(args[0]);
    case 'Boolean':
      return Boolean(args[0]);
    default:
      throw new Error(`Call to '${name}' is not allowed`);
  }
}

/** Static namespace calls (`Array.isArray`, `Date.now`) and instance methods. */
function callMemberFunction(
  callee: MemberExpressionNode,
  args: readonly unknown[],
  ctx: CustomJsContext,
  memberDepth: number,
): unknown {
  const methodName = staticMemberName(callee);

  // Static whitelist: Array.isArray / Date.now.
  if (callee.object.type === 'Identifier') {
    const namespace = callee.object.name;
    if (GLOBAL_NAMESPACE_IDENTIFIERS.has(namespace)) {
      return callStaticNamespace(namespace, methodName, args);
    }
  }

  // Instance method on an evaluated receiver.
  if (!INSTANCE_METHODS.has(methodName)) {
    throw new Error(`Method '${methodName}' is not allowed`);
  }
  const receiver = evaluateNode(callee.object, ctx, memberDepth);
  return callInstanceMethod(receiver, methodName, args);
}

function staticMemberName(callee: MemberExpressionNode): string {
  if (callee.computed) {
    throw new Error('Computed method calls are not allowed');
  }
  if (callee.property.type !== 'Identifier') {
    throw new Error('Method name must be a plain identifier');
  }
  return callee.property.name;
}

function callStaticNamespace(
  namespace: string,
  methodName: string,
  args: readonly unknown[],
): unknown {
  if (namespace === 'Array' && methodName === 'isArray') {
    return Array.isArray(args[0]);
  }
  if (namespace === 'Date' && methodName === 'now') {
    return Date.now();
  }
  throw new Error(`Call to '${namespace}.${methodName}' is not allowed`);
}

function callInstanceMethod(
  receiver: unknown,
  methodName: string,
  args: readonly unknown[],
): unknown {
  switch (methodName) {
    case 'includes':
      if (typeof receiver === 'string') return receiver.includes(String(args[0]));
      if (Array.isArray(receiver)) return receiver.includes(args[0]);
      throw new Error("'includes' is only supported on strings and arrays");
    case 'startsWith':
      requireString(receiver, methodName);
      return receiver.startsWith(String(args[0]));
    case 'endsWith':
      requireString(receiver, methodName);
      return receiver.endsWith(String(args[0]));
    case 'test':
      if (receiver instanceof RegExp) return receiver.test(String(args[0]));
      throw new Error("'test' is only supported on RegExp receivers");
    default:
      throw new Error(`Method '${methodName}' is not allowed`);
  }
}

function requireString(receiver: unknown, methodName: string): asserts receiver is string {
  if (typeof receiver !== 'string') {
    throw new Error(`'${methodName}' is only supported on strings`);
  }
}

// ─── errors ──────────────────────────────────────────────────────────────────

function unsupported(node: AstNode): Error {
  const type = (node as { type?: string }).type ?? 'unknown';
  return new Error(`Unsupported node type: ${type}`);
}
