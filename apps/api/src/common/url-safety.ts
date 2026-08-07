import { BadRequestException } from '@nestjs/common';
import { lookup as dnsLookup } from 'dns/promises';
import { isIP } from 'net';

/**
 * Shared SSRF guard.
 *
 * Used by every code path that fetches a URL supplied by a tenant: the knowledge-base
 * website crawler and the outbound webhook dispatcher. Both take a URL an
 * organization admin typed in, so both are request-forgery primitives without this.
 */
/**
 * Rejects a URL unless it is plain http(s) pointing at a publicly-routable address.
 *
 * Resolves the hostname and checks every returned address, so a public DNS name that
 * points at loopback, link-local (cloud metadata: 169.254.169.254), or RFC1918 space
 * is caught — which a string comparison on the hostname cannot do.
 */
export async function assertPublicHttpUrl(rawUrl: string): Promise<void> {
  let parsed: URL;
  try {
    parsed = new URL(rawUrl);
  } catch {
    throw new BadRequestException('Invalid website URL provided.');
  }

  if (parsed.protocol !== 'http:' && parsed.protocol !== 'https:') {
    throw new BadRequestException('Only http:// and https:// URLs can be crawled.');
  }

  const hostname = parsed.hostname.replace(/^\[|\]$/g, '').toLowerCase();

  if (hostname === 'localhost' || hostname.endsWith('.local') || hostname.endsWith('.internal')) {
    throw new BadRequestException('Crawling internal hostnames is not permitted.');
  }

  let addresses: string[];
  if (isIP(hostname)) {
    addresses = [hostname];
  } else {
    try {
      const resolved = await dnsLookup(hostname, { all: true });
      addresses = resolved.map((r) => r.address);
    } catch {
      throw new BadRequestException(`Could not resolve ${hostname}.`);
    }
  }

  if (addresses.length === 0) {
    throw new BadRequestException(`Could not resolve ${hostname}.`);
  }

  for (const address of addresses) {
    if (isPrivateAddress(address)) {
      throw new BadRequestException(
        'Crawling internal or private network addresses is strictly prohibited.'
      );
    }
  }
}

/** True for loopback, private, link-local, CGNAT, and reserved ranges. */
export function isPrivateAddress(address: string): boolean {
  const version = isIP(address);

  if (version === 4) {
    const [a, b] = address.split('.').map(Number);
    return (
      a === 0 ||                          // 0.0.0.0/8
      a === 10 ||                         // 10.0.0.0/8
      a === 127 ||                        // loopback
      (a === 169 && b === 254) ||         // link-local, incl. cloud metadata
      (a === 172 && b >= 16 && b <= 31) ||// 172.16.0.0/12
      (a === 192 && b === 168) ||         // 192.168.0.0/16
      (a === 100 && b >= 64 && b <= 127) ||// CGNAT 100.64.0.0/10
      a >= 224                            // multicast + reserved
    );
  }

  if (version === 6) {
    const normalized = address.toLowerCase();
    // IPv4-mapped (::ffff:a.b.c.d) — re-check as IPv4.
    const mapped = normalized.match(/^::ffff:(\d+\.\d+\.\d+\.\d+)$/);
    if (mapped) return isPrivateAddress(mapped[1]);

    return (
      normalized === '::' ||
      normalized === '::1' ||             // loopback
      normalized.startsWith('fc') ||      // unique local fc00::/7
      normalized.startsWith('fd') ||
      normalized.startsWith('fe80') ||    // link-local
      normalized.startsWith('ff')         // multicast
    );
  }

  // Unparseable — refuse rather than guess.
  return true;
}
