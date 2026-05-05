# Reference — Audience targeting schema

JSON shape per experiment for the new 4.0 audience targeting. Replaces the flat `targeting[]` of 3.3.x/3.6 with a properly nestable boolean tree of typed dimension rules.

Type definitions live in `packages/shared-types/src/audience.ts`. Crobot's testa-admin builds these in the `ProjectResource` form and publishes the final JSON to KV. The pixel evaluates them on the client. (See `docs/architecture/01-tracker.md` § Integration model — audience evaluation is pixel-side; the worker does not run a rule engine in the default integration path.)

## Top-level

Each active experiment in `ProjectConfig.experiments[]` carries:

```json
{
  "experiment_id": 17,
  "audience": { ... AudienceCondition ... },
  ...
}
```

If `audience` is absent, the experiment matches every visitor (subject to `traffic_allocation`).

## Schema

```ts
export type AudienceCondition =
  | { all: AudienceCondition[] }    // AND
  | { any: AudienceCondition[] }    // OR
  | { not: AudienceCondition }      // NOT
  | AudienceLeaf;

export type AudienceLeaf =
  | { fact: 'page.url';            op: UrlOp;       value: string }
  | { fact: 'page.queryParam';     op: StrOp;       key: string; value: string }
  | { fact: 'page.referrer';       op: UrlOp;       value: string }
  | { fact: 'visitor.cookie';      op: StrOp;       key: string; value: string }
  | { fact: 'visitor.isReturning'; op: 'is';        value: boolean }
  | { fact: 'visitor.dataLayer';   op: StrOp;       path: string; value: string }
  | { fact: 'visitor.custom';      op: 'truthy';    js: string }     // sandboxed
  | { fact: 'geo.country';         op: 'in' | 'notIn'; value: string[] }
  | { fact: 'geo.region';          op: 'in' | 'notIn'; value: string[] }
  | { fact: 'device.type';         op: 'in' | 'notIn'; value: ('desktop' | 'mobile' | 'tablet')[] }
  | { fact: 'device.browser';      op: 'in' | 'notIn'; value: string[] }
  | { fact: 'device.os';           op: 'in' | 'notIn'; value: string[] }
  | { fact: 'device.viewportWidth';op: NumOp;       value: number }
  | { fact: 'device.language';     op: StrOp;       value: string }
  | { fact: 'time.hourOfDay';      op: 'in';        value: number[]; tz: string }
  | { fact: 'time.dayOfWeek';      op: 'in';        value: number[]; tz: string }     // 0 = Sunday
  | { fact: 'time.window';         op: 'between';   from: string; to: string; tz: string }   // ISO 8601
  | { fact: 'experiment.assignedTo'; op: 'is' | 'isNot'; experimentId: number; variationId?: number };

type UrlOp = 'exact' | 'contains' | 'notContains' | 'regex' | 'startsWith' | 'endsWith';
type StrOp = 'equals' | 'notEquals' | 'contains' | 'notContains' | 'regex' | 'exists' | 'notExists';
type NumOp = 'eq' | 'lt' | 'lte' | 'gt' | 'gte' | 'between';   // `between` uses { min, max }
```

## Examples

### "First-time mobile visitors from DE/AT/CH"

```json
{
  "all": [
    { "fact": "visitor.isReturning", "op": "is", "value": false },
    { "fact": "device.type",         "op": "in", "value": ["mobile"] },
    { "fact": "geo.country",         "op": "in", "value": ["DE", "AT", "CH"] }
  ]
}
```

### "On a product page, but not from email campaign"

```json
{
  "all": [
    { "fact": "page.url",        "op": "contains", "value": "/products/" },
    { "not": { "fact": "page.queryParam", "op": "equals", "key": "utm_medium", "value": "email" } }
  ]
}
```

### "Returning visitors with order_count > 3 (custom JS via dataLayer)"

```json
{
  "all": [
    { "fact": "visitor.isReturning", "op": "is", "value": true },
    { "fact": "visitor.custom",
      "op": "truthy",
      "js": "Number(visitor.dataLayer.order_count) > 3" }
  ]
}
```

### "Weekend, business hours, EU only"

```json
{
  "all": [
    { "fact": "geo.country",   "op": "in", "value": ["DE","FR","IT","ES","NL","SE","DK","FI","NO","PT","BE","AT","CH","IE","PL","CZ","SK","HU","RO","GR"] },
    { "fact": "time.dayOfWeek","op": "in", "value": [0, 6], "tz": "Europe/Berlin" },
    { "fact": "time.hourOfDay","op": "in", "value": [10,11,12,13,14,15,16,17,18,19], "tz": "Europe/Berlin" }
  ]
}
```

## Custom JS expressions (`visitor.custom`)

The `js` field is **not arbitrary JavaScript**. It's a sandboxed expression compiled at config-publish time in crobot, AST-shipped in the JSON, evaluated by `apps/pixel/src/rules/custom-js.ts`. The sandbox:

- **Allowed identifiers:** `visitor`, `page`, `session` only. (Same context object the rule engine uses.)
- **Allowed member access:** anything on those three roots; including arbitrary `dataLayer.*` paths the customer site populates.
- **Allowed operators:** `===`, `!==`, `<`, `<=`, `>`, `>=`, `&&`, `||`, `!`, `+`, `-`, `*`, `/`, `%`, `?:`.
- **Allowed function calls:** `String(...)`, `Number(...)`, `Boolean(...)`, `Array.isArray(...)`, `String.prototype.includes`, `String.prototype.startsWith`, `String.prototype.endsWith`, `Date.now()`, regex literals + `.test()`. Whitelist; nothing else.
- **Disallowed:** `window.*`, `document.*`, `eval`, `Function`, `import`, `fetch`, `XMLHttpRequest`, any DOM access, any setter, any `=` assignment.

Reject at config-publish time if the AST contains anything not on the whitelist. Crobot's job: parse the expression, validate the AST, ship the AST in JSON. Pixel side: walk the AST, no `eval`.

## Backwards compatibility

Legacy projects on `integration_version: '3.4'` or `'3.6'` keep their flat `targeting[]` shape. Only `'4.0'` projects consume the new `audience` field. The pixel reads `audience` if present, falls back to `targeting[]` otherwise. Crobot's `PublishProjectConfigToKV` job emits one or the other based on which form the admin used to author the rules.

## Why this shape

- **Discriminated union by `fact`** → exhaustive `switch` in the evaluator, TS catches missing cases at compile time.
- **`all`/`any`/`not` tree** → expresses any boolean composition, including the `(country=DE AND mobile) OR (country=US AND desktop)` case the old "OR-within-type, AND-across-type" couldn't.
- **No JSONLogic** — admin UI is dimension-driven (pick a fact, pick an op, pick a value), and the discriminated union maps cleanly to admin form fields per dimension.
- **Sandboxed JS** instead of `eval` — CSP-safe, no lateral-movement risk if a customer's site is compromised.

## Adding a new dimension

1. Add the new variant to `AudienceLeaf` in `packages/shared-types/src/audience.ts`.
2. Implement the case in `apps/pixel/src/rules/audience.ts`. TS will fail to compile until you do.
3. Add admin form in crobot's `ProjectResource`.
4. Add fixtures + tests in `apps/pixel/src/__tests__/rules/`.
5. Update this doc.

Don't ship a dimension partially — schema, evaluator, admin UI, tests must all land together.
