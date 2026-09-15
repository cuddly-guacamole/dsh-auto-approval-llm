// Contract: the client permission-row matcher must recognize the plugin-owned
// `auto-approval` host label (`Auto approval`, localized to 自动审批) and the
// legacy `Auto` label during the compatibility window, while never matching the
// upstream experimental `Auto review` row.
import { test } from 'node:test'
import assert from 'node:assert/strict'
import { PERMISSION_LABEL_SETS, isPermissionMenu, isAutoTrigger } from '../lib/client/auto-icon.js'

const OTHER_TIERS = ['Read Only', 'Workspace Write', 'Full access']
const menuOf = (...labels) => ({
    querySelectorAll: () => labels.map((textContent) => ({ textContent })),
})

test('the auto label set declares the new host label and keeps the compat window', () => {
    assert.ok(PERMISSION_LABEL_SETS.auto.includes('Auto approval'), 'new host label must be declared')
    assert.ok(PERMISSION_LABEL_SETS.auto.includes('自动审批'), 'zh label must be declared')
    assert.ok(PERMISSION_LABEL_SETS.auto.includes('Auto'), 'legacy label must stay for the compat window')
})

test('the upstream experimental label is never part of the matcher', () => {
    assert.ok(!PERMISSION_LABEL_SETS.auto.includes('Auto review'), 'Auto review belongs to upstream auto-review')
})

test('a permission menu is recognized with the new Auto approval label', () => {
    assert.equal(isPermissionMenu(menuOf(...OTHER_TIERS, 'Auto approval')), true)
})

test('a permission menu is recognized with the legacy Auto label', () => {
    assert.equal(isPermissionMenu(menuOf(...OTHER_TIERS, 'Auto')), true)
})

test('a permission menu is recognized with the zh label', () => {
    assert.equal(isPermissionMenu(menuOf('仅可查看', '工作区内修改', '完全权限', '自动审批')), true)
})

test('a menu carrying only the upstream Auto review row is not our menu', () => {
    assert.equal(isPermissionMenu(menuOf(...OTHER_TIERS, 'Auto review')), false)
})

const triggerOf = (label) => ({
    matches: (selector) => selector === 'button[aria-label]',
    getAttribute: (name) => (name === 'aria-label' ? label : null),
})

test('trigger matcher accepts the new, legacy and zh labels', () => {
    assert.equal(isAutoTrigger(triggerOf('Access mode: Auto approval')), true)
    assert.equal(isAutoTrigger(triggerOf('访问模式，当前：Auto approval')), true)
    assert.equal(isAutoTrigger(triggerOf('访问模式，当前：自动审批')), true)
    assert.equal(isAutoTrigger(triggerOf('Access mode: Auto')), true)
})

test('trigger matcher rejects the upstream Auto review label', () => {
    assert.equal(isAutoTrigger(triggerOf('Access mode: Auto review')), false)
    assert.equal(isAutoTrigger(triggerOf('访问模式，当前：Auto review')), false)
})
