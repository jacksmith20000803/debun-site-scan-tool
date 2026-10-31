'use strict';

const test = require('node:test');
const assert = require('node:assert/strict');
const http = require('node:http');
const { checkWordPressExposure } = require('../src/wordpress-security-checks');

test('WordPress exposure checks are read-only and report public REST user enumeration without copying user data', async () => {
  const methods = [];
  const server = http.createServer((request, response) => {
    methods.push(request.method);
    if (request.url.startsWith('/wp-json/wp/v2/users')) {
      response.writeHead(200, { 'content-type': 'application/json' });
      response.end(JSON.stringify([{ id: 7, slug: 'private-test-user', name: 'Private Test User' }]));
      return;
    }
    if (request.url === '/xmlrpc.php') {
      response.writeHead(405, { 'content-type': 'text/plain' });
      response.end('XML-RPC server accepts POST requests only.');
      return;
    }
    response.writeHead(200, { 'content-type': 'text/html' });
    response.end('<html></html>');
  });
  await new Promise((resolve) => server.listen(0, '127.0.0.1', resolve));
  try {
    const result = await checkWordPressExposure(`http://127.0.0.1:${server.address().port}/`);
    assert.ok(result.findings.some((finding) => finding.id === 'wordpress-rest-users-public'));
    assert.ok(result.findings.some((finding) => finding.id === 'wordpress-xmlrpc-exposed'));
    assert.ok(!JSON.stringify(result).includes('private-test-user'));
    assert.ok(!JSON.stringify(result).includes('Private Test User'));
    assert.deepEqual([...new Set(methods)], ['GET']);
    assert.ok(result.notTested.some((item) => item.category === 'SQL injection'));
    assert.ok(result.notTested.some((item) => item.category === 'XXE'));
  } finally {
    server.closeAllConnections();
    await new Promise((resolve, reject) => server.close((error) => error ? reject(error) : resolve()));
  }
});
