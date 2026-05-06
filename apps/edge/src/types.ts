/**
 * Bindings + global Env shape for the Cloudflare Worker.
 *
 * Imported by every route module so they don't have to redeclare it.
 */
export interface Env {
  KV_PROJECT_CONFIG: KVNamespace;
  KV_INTEGRATION_BUNDLES: KVNamespace;
  BATCH_BUFFER: DurableObjectNamespace;
  INGEST_SHARED_SECRET: string;
  INGEST_ORIGIN_URL: string;
  COOKIE_FALLBACK_DOMAIN: string;
  VISITOR_ID_SALT: string;
  ENVIRONMENT: string;
}
