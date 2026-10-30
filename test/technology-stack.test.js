'use strict';

const { test } = require('node:test');
const assert = require('node:assert/strict');
const { detectTechnologyStack } = require('../src/technology-stack');
const { sitemapUrlsFromRobots, discoverSitemapLinks } = require('../src/mdream-crawler');

test('technology stack finds CMS, CDN, WAF, analytics, and payments with public evidence', () => {
  const found = detectTechnologyStack({
    html: '<script src="https://js.stripe.com/v3/"></script><script src="https://www.googletagmanager.com/gtag/js?id=G-ABC"></script><img src="/wp-content/plugins/demo/logo.png">',
    urls: ['https://www.googletagmanager.com/gtag/js?id=G-ABC', 'https://js.stripe.com/v3/'],
    headers: { server: 'cloudflare', 'cf-ray': 'abc-TYO', 'cf-mitigated': 'challenge' },
  });
  const names = found.map((item) => item.name);
  assert.ok(names.includes('WordPress'));
  assert.ok(names.includes('Cloudflare'));
  assert.ok(names.includes('Cloudflare WAF / challenge layer'));
  assert.ok(names.includes('Google Analytics'));
  assert.ok(names.includes('Stripe'));
  assert.ok(found.every((item) => item.confidence > 0.8 && item.evidence.length > 0));
});

test('technology stack does not invent products when there are no recognizable public markers', () => {
  assert.deepEqual(detectTechnologyStack({ html: '<title>Plain site</title>', urls: [], headers: { server: 'nginx' } }), []);
});

test('sitemap discovery honors robots rules and restricts discovered URLs to the site origin', async () => {
  const robots = 'User-agent: *\nDisallow: /private\nSitemap: https://shop.example.test/maps/index.xml';
  assert.deepEqual(sitemapUrlsFromRobots(robots), ['https://shop.example.test/maps/index.xml']);
  const documents = new Map([
    ['https://shop.example.test/maps/index.xml', '<sitemapindex><sitemap><loc>https://shop.example.test/maps/pages.xml</loc></sitemap></sitemapindex>'],
    ['https://shop.example.test/sitemap.xml', '<urlset/>'],
    ['https://shop.example.test/maps/pages.xml', '<urlset><url><loc>https://shop.example.test/one</loc></url><url><loc>https://shop.example.test/private/admin</loc></url><url><loc>https://other.example.test/offsite</loc></url></urlset>'],
  ]);
  const ofetch = { raw: async (url) => ({ status: 200, _data: documents.get(url) || '' }) };
  const links = await discoverSitemapLinks('https://shop.example.test/', robots, [{ allow: false, path: '/private' }], ofetch);
  assert.deepEqual(links, ['https://shop.example.test/one']);
});
