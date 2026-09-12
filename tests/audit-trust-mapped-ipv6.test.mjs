/**
 * dsh-auto-approval-llm · every IPv4-mapped IPv6 spelling is non-public.
 *
 * The SSRF fence (reviewer base URL / probe target) must refuse an address
 * whose real target is private or metadata. `isPublicIpv6` recognised only the
 * dotted tail of a fully written `0:0:0:0:0:ffff:a.b.c.d`, so the hex-spelled
 * mapped forms fell through to the final charset test and were reported as
 * globally reachable: `::ffff:a9fe:a9fe` is 169.254.169.254 (cloud metadata)
 * and `::ffff:a00:1` is 10.0.0.1. The module's stated contract rejects mapped
 * forms outright; the dotted `::ffff:8.8.8.8` only passed by accident of the
 * charset test.
 */
import test from 'node:test'
import assert from 'node:assert/strict'
import { isPublicIpAddress, isPublicIpv6 } from '../lib/auto/trust.js'

test('hex-spelled IPv4-mapped forms are not public', () => {
  for (const address of ['::ffff:a9fe:a9fe', '::ffff:a00:1', '::ffff:c0a8:101', '::ffff:7f00:1']) {
    assert.equal(isPublicIpv6(address), false, `${address} is an IPv4-mapped address`)
    assert.equal(isPublicIpAddress(address), false, `${address} must not pass the SSRF fence`)
  }
})

test('the fully written mapped spelling is not public either', () => {
  for (const address of ['0:0:0:0:0:ffff:a9fe:a9fe', '0:0:0:0:0:ffff:8.8.8.8', '0000:0000:0000:0000:0000:ffff:a00:1']) {
    assert.equal(isPublicIpv6(address), false, `${address} is an IPv4-mapped address`)
  }
})

test('the dotted spelling keeps its pinned verdict', () => {
  assert.equal(isPublicIpAddress('::ffff:8.8.8.8'), false)
  assert.equal(isPublicIpAddress('::ffff:10.0.0.1'), false)
})

test('genuinely public IPv6 stays public', () => {
  for (const address of ['2001:4860:4860::8888', '2606:4700:4700::1111', '[2606:4700:4700::1111]']) {
    assert.equal(isPublicIpAddress(address), true, `${address} is globally reachable`)
  }
})

test('loopback and unspecified stay refused', () => {
  for (const address of ['::1', '::']) assert.equal(isPublicIpAddress(address), false)
})
