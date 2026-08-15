/**
 * SSRF defence for the knowledge-base website crawler.
 *
 * The original check compared the hostname STRING against a handful of literal
 * private addresses. That stops `http://127.0.0.1/` and nothing else: a public DNS
 * name pointing at the cloud metadata endpoint, an integer-encoded IP, or an
 * IPv6-mapped address all sailed through and let an authenticated tenant read
 * internal services (including AWS/GCP instance credentials at 169.254.169.254).
 *
 * DNS is mocked so these assertions do not depend on the network.
 */

const mockLookup = jest.fn();
jest.mock('dns/promises', () => ({ lookup: (...args: any[]) => mockLookup(...args) }));

import { BadRequestException } from '@nestjs/common';
import { KnowledgeService } from '../src/knowledge/knowledge.service';

/** Reaches the private module-scope guard through the public crawl entry point. */
async function crawl(url: string) {
  const service = new KnowledgeService();
  return service.crawlAndIndexWebsite('org_1', url);
}

describe('Web crawler SSRF defence', () => {
  beforeEach(() => {
    jest.clearAllMocks();
    // Any hostname that reaches DNS resolves to a public address unless a test
    // overrides it, so a rejection means the guard fired rather than the lookup.
    mockLookup.mockResolvedValue([{ address: '93.184.216.34', family: 4 }]);
    // Fail loudly if a request ever escapes the guard.
    global.fetch = jest.fn(() => {
      throw new Error('fetch must not be reached for a blocked URL');
    }) as any;
  });

  describe('literal private addresses', () => {
    const blocked = [
      'http://127.0.0.1/',
      'http://0.0.0.0/',
      'http://10.0.0.5/admin',
      'http://192.168.1.1/',
      'http://172.16.0.1/',
      'http://172.31.255.255/',
      'http://169.254.169.254/latest/meta-data/',
      'http://100.64.0.1/',
      'http://[::1]/',
      'http://[fd00::1]/',
      'http://[fe80::1]/',
      'http://localhost/',
      'http://api.internal/',
      'http://db.local/',
    ];

    it.each(blocked)('rejects %s', async (url) => {
      await expect(crawl(url)).rejects.toBeInstanceOf(BadRequestException);
    });
  });

  describe('addresses the string-matching check could not see', () => {
    it('rejects a public hostname that RESOLVES to the cloud metadata endpoint', async () => {
      // The whole class of bypass the old check missed: nothing about
      // "metadata.evil.com" looks private until you resolve it.
      mockLookup.mockResolvedValue([{ address: '169.254.169.254', family: 4 }]);
      await expect(crawl('https://metadata.evil.com/')).rejects.toBeInstanceOf(BadRequestException);
    });

    it('rejects a public hostname that resolves to RFC1918 space', async () => {
      mockLookup.mockResolvedValue([{ address: '10.1.2.3', family: 4 }]);
      await expect(crawl('https://intranet-shortcut.example.com/')).rejects.toBeInstanceOf(
        BadRequestException
      );
    });

    it('rejects when ANY resolved address is private, not just the first', async () => {
      mockLookup.mockResolvedValue([
        { address: '93.184.216.34', family: 4 },
        { address: '169.254.169.254', family: 4 },
      ]);
      await expect(crawl('https://split-horizon.example.com/')).rejects.toBeInstanceOf(
        BadRequestException
      );
    });

    it('rejects an IPv4-mapped IPv6 loopback', async () => {
      await expect(crawl('http://[::ffff:127.0.0.1]/')).rejects.toBeInstanceOf(BadRequestException);
    });
  });

  describe('scheme restrictions', () => {
    it.each(['file:///etc/passwd', 'gopher://127.0.0.1:11211/', 'ftp://internal/'])(
      'rejects %s',
      async (url) => {
        await expect(crawl(url)).rejects.toBeInstanceOf(BadRequestException);
      }
    );
  });

  describe('unresolvable hosts', () => {
    it('rejects rather than attempting the request', async () => {
      mockLookup.mockRejectedValue(new Error('ENOTFOUND'));
      await expect(crawl('https://does-not-exist.example/')).rejects.toBeInstanceOf(
        BadRequestException
      );
    });
  });

  describe('legitimate targets', () => {
    it('passes the guard and proceeds to fetch a public host', async () => {
      // The guard must let this through; the fetch stub then rejects, proving we got
      // past validation rather than being blocked by it.
      global.fetch = jest.fn(async () => ({
        status: 200,
        ok: true,
        headers: new Map([['content-type', 'text/html']]) as any,
        text: async () => '<html><body>' + 'Public content. '.repeat(20) + '</body></html>',
      })) as any;

      // Reaches the DB layer, which is unavailable in this suite — so anything other
      // than a BadRequestException means the SSRF guard allowed the request.
      await expect(crawl('https://example.com/')).rejects.not.toBeInstanceOf(BadRequestException);
      expect(global.fetch).toHaveBeenCalled();
    });
  });
});
