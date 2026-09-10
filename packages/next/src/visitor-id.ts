/**
 * `setVisitorId` — hand the proxy a visitor id computed inside your own
 * middleware, for the cases the `visitorId` option cannot cover.
 *
 * The option is a SYNCHRONOUS resolver called from inside the decision path, so
 * it can only return an id already derivable from the request — a cookie, a
 * header. An id that has to be awaited (a session lookup, a KV read, an auth
 * call) cannot come from there. This can: you resolve it in your own handler,
 * however long that takes, then hand it over before delegating.
 *
 *   const testa = createTestaProxy({ projectId: '…' })
 *
 *   export async function proxy(req: NextRequest, event: NextFetchEvent) {
 *     setVisitorId(req, await mySessionLookup(req))
 *     return testa(req, event)
 *   }
 *
 * KEYED ON THE REQUEST, deliberately. A module-level `setVisitorId(id)` would
 * be a correctness bug rather than a style choice: one isolate serves many
 * requests concurrently, so a value parked in module scope by one visitor can
 * be read by another mid-flight and assign them someone else's variation. A
 * `WeakMap` keyed by the request object cannot cross requests, needs no
 * `AsyncLocalStorage`, and lets entries be collected with the request itself.
 *
 * CAVEAT: identity is the request OBJECT. Pass the same instance you called
 * `setVisitorId` with — constructing a new `NextRequest` (to override request
 * headers, say) produces a different key and the id is not found. Set it on
 * whichever instance you actually hand to the proxy.
 *
 * Precedence in the proxy: this, then the `visitorId` option, then Testa's own
 * `_testa_uuid`.
 */

/**
 * Anything object-like can key the map; typed loosely so this module needs no
 * `next/server` import and stays unit-testable with a plain object.
 */
type RequestKey = object;

const supplied = new WeakMap<RequestKey, string>();

/**
 * Use `visitorId` as this request's visitor id, overriding the `visitorId`
 * option and Testa's own cookie. An empty id is ignored, so a lookup that
 * comes back blank falls through to the normal resolution rather than
 * assigning an unusable identity.
 *
 * The id must be STABLE per visitor: bucketing is
 * `hash(visitorId:experimentId)`, so one that changes re-buckets the visitor
 * and corrupts assignment itself, not merely the count.
 */
export function setVisitorId(request: RequestKey, visitorId: string): void {
  if (!visitorId) return;
  supplied.set(request, visitorId);
}

/** The id set for this request, if any. Internal to the proxy. */
export function getSuppliedVisitorId(request: RequestKey): string | undefined {
  return supplied.get(request);
}
