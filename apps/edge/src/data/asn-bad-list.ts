/**
 * Conservative blocklist of ASNs known for hosting bot / scraper / DC traffic.
 *
 * Why conservative: false positives hurt revenue measurement (a real customer
 * on a corporate VPN routed through DigitalOcean shouldn't get tagged as a bot).
 * The list flags an event as a heuristic hit (+50 to score) but doesn't drop it.
 *
 * Periodically refresh against public bot-traffic reports. Add an ASN here only
 * with concrete evidence — at least one published study showing >40% bot traffic
 * from that ASN, or a customer support incident traced back to it.
 */
export const BOT_ASN_BLOCKLIST = new Set<number>([
  14061, // DigitalOcean
  16509, // Amazon AWS (us-east)
  14618, // Amazon AWS (additional ranges)
  16276, // OVH
  20473, // Choopa / Vultr
  24940, // Hetzner
  63949, // Linode (now Akamai)
  46606, // Unified Layer / Bluehost (high botnet hosting)
  9009, // M247 (datacenter / VPN)
  62240, // Clouvider
]);
