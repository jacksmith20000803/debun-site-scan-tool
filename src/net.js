'use strict';

/**
 * Network bootstrap.
 *
 * Some networks advertise IPv6 (AAAA) records but have no working IPv6 route.
 * Node's "happy eyeballs" auto-selection then stalls on IPv6 and HTTP requests
 * time out. We prefer IPv4 and disable auto-selection so requests complete
 * quickly and deterministically.
 *
 * Require this module before any HTTP client is used.
 */
const dns = require('node:dns');
const net = require('node:net');

try {
  dns.setDefaultResultOrder('ipv4first');
} catch (_) {
  /* older Node: ignore */
}

try {
  if (typeof net.setDefaultAutoSelectFamily === 'function') {
    net.setDefaultAutoSelectFamily(false);
  }
} catch (_) {
  /* ignore */
}

module.exports = {};
