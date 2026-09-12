/**
 * The public-address predicate is documented as mirroring the official
 * `ipaddr.js range() === 'unicast'` check (@deepseek-ai/dsh-web-fetch-http).
 * Compared address by address, the per-prefix table it replaced let several
 * special-purpose blocks through as "globally reachable unicast": the reserved
 * 0000::/8 block, the discard-only 0100::/64 block, the IETF
 * protocol-assignment 2001::/23 block (Teredo, benchmarking, ORCHID v1/v2,
 * AS112 — the table named only a few members), the deprecated site-local
 * fec0::/10 block and the SRv6 SID block 5f00::/16. A reviewer endpoint
 * resolving into one of them would have received the API key.
 *
 * Pins the refused blocks, the public controls that must stay reachable, and
 * the IPv4 behaviour that shares the same predicate.
 * Run: node --test tests/audit-ipv6-special-blocks.test.mjs
 */
import test from 'node:test'
import assert from 'node:assert/strict'
import { isPublicIpAddress } from '../lib/auto/trust.js'

test('special-purpose IPv6 blocks are not public', () => {
  for (const address of [
    '0::1', '0:0:0:0:0:0:0:1', '100::1', '100::', '100:0:0:0:ffff::1',
    '5f00::1', '5f00:1::1',
    'fec0::1', 'fecf::1', 'fed0::1', 'fee0::1', 'fef0::1', 'feff::1',
    '2001::1', '2001:0:1::1', '2001:1::1', '2001:2::1', '2001:3::1',
    '2001:10::1', '2001:1f::1', '2001:20::1', '2001:2f::1', '2001:4:112::1',
    '2001:db8::1', 'fe80::1', 'fc00::1', 'ff02::1', '::1', '::',
  ]) {
    assert.equal(isPublicIpAddress(address), false, `${address} must not count as public`)
  }
})

test('global unicast addresses stay reachable', () => {
  for (const address of [
    '2001:200::1', '2001:4860:4860::8888', '2606:4700:4700::1111', '2a00:1450:4001::1',
    '100:0:0:1::1', '100:0:1::1', '5f01::1', 'fe00::1', '2001:300::1', '2600::1',
  ]) {
    assert.equal(isPublicIpAddress(address), true, `${address} must stay public`)
  }
})

test('IPv4-mapped spellings of a private address stay refused', () => {
  for (const address of ['::ffff:169.254.169.254', '::ffff:a9fe:a9fe', '0:0:0:0:0:ffff:10.0.0.5', '::ffff:8.8.8.8']) {
    assert.equal(isPublicIpAddress(address), false, `${address} must not count as public`)
  }
})

test('the IPv4 half is unchanged', () => {
  for (const address of ['8.8.8.8', '1.1.1.1', '100:0:0:1::1']) {
    if (address.includes(':')) continue
    assert.equal(isPublicIpAddress(address), true, `${address} must stay public`)
  }
  for (const address of ['10.0.0.5', '127.0.0.1', '169.254.169.254', '100.64.0.1', '192.168.1.1', '198.18.0.1', '203.0.113.9', '0.0.0.0']) {
    assert.equal(isPublicIpAddress(address), false, `${address} must not count as public`)
  }
})
