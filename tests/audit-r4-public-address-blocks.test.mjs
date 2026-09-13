/**
 * Special-purpose address blocks in the reviewer/classifier SSRF fence.
 *
 * `isPublicIpv4` / `isPublicIpv6` stand in for the official
 * `ipaddr.js range() === 'unicast'` check, and the comments claim alignment
 * "verified against the official package's own tables". Four IPv4 blocks and
 * one IPv6 block were missing, so credentials and prompt text could be sent to
 * addresses the oracle classifies as reserved/as112/amt rather than unicast.
 * The comparison was run against the DSH tree's real ipaddr.js: every address
 * inside those blocks disagreed (ours true, oracle not unicast).
 *
 * Run: node --test tests/audit-r4-public-address-blocks.test.mjs (tsc first)
 */
import test from 'node:test'
import assert from 'node:assert/strict'
import { isPublicIpv4, isPublicIpv6 } from '../lib/auto/trust.js'

const BLOCKED_IPV4 = [
  ['192.88.99.1', '6to4 relay anycast'],
  ['192.88.99.254', '6to4 relay anycast'],
  ['192.175.48.1', 'AS112'],
  ['192.31.196.1', 'AS112'],
  ['192.52.193.1', 'AMT'],
]

test('every special-purpose IPv4 block the oracle refuses is refused here', () => {
  for (const [address, why] of BLOCKED_IPV4) {
    assert.equal(isPublicIpv4(address), false, `${address} (${why}) must not be treated as public`)
  }
})

test('the neighbours of those blocks stay public (no over-blocking)', () => {
  for (const address of [
    '192.88.100.1', '192.88.98.1', '192.175.49.1', '192.175.47.1',
    '192.31.197.1', '192.31.195.1', '192.52.194.1', '192.52.192.1',
  ]) {
    assert.equal(isPublicIpv4(address), true, `${address} is outside every special-purpose block`)
  }
})

test('the AS112 v6 anycast prefix is refused in its spellings', () => {
  for (const address of ['2620:4f:8000::1', '2620:4f:8000:1::1', '2620:004f:8000::1234', '2620:4f:8000:ffff::1']) {
    assert.equal(isPublicIpv6(address), false, `${address} is inside 2620:4f:8000::/48`)
  }
  for (const address of ['2620:4f:8001::1', '2620:50:8000::1', '2606:4700::1111']) {
    assert.equal(isPublicIpv6(address), true, `${address} is outside the AS112 v6 block`)
  }
})
