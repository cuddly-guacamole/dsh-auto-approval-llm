// @ts-nocheck
// Ported from @nanmicoder/dsh-auto-mode (client/icon-injection.js).
// MIT License, Copyright (c) 2026 程序员阿江-Relakkes (https://github.com/NanmiCoder/dsh-auto-mode).
// Retained per the MIT License: this is a substantial portion of the original.
//
// Localized + separated rendering follows the official access-mode surfaces:
//   - menu item:  <span class=itemIcon><svg aria-hidden/></span><span class=itemLabel>label</span>
//   - trigger:    <span class=triggerIcon><svg aria-hidden/></span><span class=triggerLabel>label</span><span chevron/>
//   - /permission tooltip rows and the settings selector carry the label only (official shows no glyph there).
// The label is localized: zh → 自动审批, everything else → Auto.
const PLUGIN_ID = 'dsh-auto-approval-llm';
const ICON_ATTRIBUTE = 'data-dsh-auto-mode-icon';
const LABEL_ATTRIBUTE = 'data-dsh-auto-mode-label';
const DIALOG_ATTRIBUTE = 'data-dsh-auto-mode-risk-dialog';
// Both locales of the four presets; a permission menu matches when every
// preset slot is present in either language (the ported implementation only
// shipped the English set, which silently dropped the zh menu).
export const PERMISSION_LABEL_SETS = {
    readOnly: ['Read Only', '仅可查看'],
    // alpha.4 reworded the workspace-write preset in zh ("工作区内修改");
    // keep the rc.2 variant so both official generations match the menu gate.
    workspaceWrite: ['Workspace Write', '可写入工作区', '工作区内修改'],
    auto: ['Auto', '自动审批'],
    fullAccess: ['Full access', '完全权限'],
};
// Shield outline + bolt, drawn 1:1 like the official 16px permission glyphs
// (stroke currentColor / fill currentColor, aria-hidden wrapper).
const SHIELD_PATH = 'M8.20554 0.899994L14.7901 3.36857V7.01026C14.7901 12 11.0466 14.2103 8.20554 15.3C5.36446 14.2103 1.62012 12 1.62012 7.01026V3.36857L8.20554 0.899994Z';
const BOLT_PATH = 'M8.75 3.65 5.95 8.2h2.08l-.78 4.15 2.82-4.9H8.12l.63-3.8Z';
// The official preset name for `auto` in this deployment's patch (cordis.patch.yml).
const CONFIGURED_AUTO_NAME = 'Auto';
function autoName(document) {
    const language = document.documentElement.lang || document.defaultView?.navigator.language || '';
    return /^zh(?:-|$)/i.test(language) ? '自动审批' : CONFIGURED_AUTO_NAME;
}
function iconStyles() {
    return `
.dsa-autoIcon {
  display: inline-flex;
  flex: none;
  width: 16px;
  height: 16px;
  align-items: center;
  justify-content: center;
  color: var(--dsw-alias-label-tertiary, currentColor);
}
.dsa-autoIconTrigger {
  width: 14px;
  height: 14px;
}
[${DIALOG_ATTRIBUTE}] {
  position: fixed;
  inset: 0;
  z-index: 1000;
  display: flex;
  align-items: center;
  justify-content: center;
  padding: 24px;
  color: var(--dsw-alias-label-primary, #171717);
}
[${DIALOG_ATTRIBUTE}] .dsh-auto-risk-mask {
  position: absolute;
  inset: 0;
  background: var(--dsw-alias-bg-mask-1, rgba(0, 0, 0, 0.24));
  backdrop-filter: var(--dsw-mask-blur, blur(2px));
}
[${DIALOG_ATTRIBUTE}] .dsh-auto-risk-card {
  position: relative;
  z-index: 1;
  display: flex;
  flex-direction: column;
  gap: 20px;
  width: min(440px, 100%);
  max-height: calc(100vh - 48px);
  padding: 0 0 24px;
  overflow: hidden;
  border: 1px solid var(--dsw-alias-border-inverted, rgba(0, 0, 0, 0.08));
  border-radius: 24px;
  background: var(--dsw-alias-bg-layer-2, #fff);
  box-shadow: var(--dsw-shadow-lv3, 0 18px 48px rgba(0, 0, 0, 0.18));
}
[${DIALOG_ATTRIBUTE}] .dsh-auto-risk-content {
  min-height: 0;
  overflow-y: auto;
  overscroll-behavior: contain;
}
[${DIALOG_ATTRIBUTE}] .dsh-auto-risk-header {
  display: flex;
  align-items: center;
  justify-content: space-between;
  gap: 8px;
  padding: 22px 14px 12px 24px;
}
[${DIALOG_ATTRIBUTE}] .dsh-auto-risk-title {
  margin: 0;
  font-size: 16px;
  line-height: 24px;
  font-weight: 500;
}
[${DIALOG_ATTRIBUTE}] .dsh-auto-risk-close {
  flex: none;
  display: inline-flex;
  align-items: center;
  justify-content: center;
  width: 28px;
  height: 28px;
  padding: 0;
  border: 0;
  border-radius: 8px;
  color: var(--dsw-alias-label-secondary, #666);
  background: transparent;
  font: inherit;
  font-size: 22px;
  line-height: 1;
  cursor: pointer;
}
[${DIALOG_ATTRIBUTE}] .dsh-auto-risk-close:hover {
  background: var(--dsw-alias-interactive-bg-hover, rgba(0, 0, 0, 0.05));
}
[${DIALOG_ATTRIBUTE}] .dsh-auto-risk-body {
  padding: 0 24px;
}
[${DIALOG_ATTRIBUTE}] .dsh-auto-risk-warning {
  display: flex;
  align-items: flex-start;
  gap: 10px;
  color: var(--dsw-alias-label-secondary, #666);
  font-size: 14px;
  line-height: 22px;
}
[${DIALOG_ATTRIBUTE}] .dsh-auto-risk-warning p {
  margin: 0;
}
[${DIALOG_ATTRIBUTE}] .dsh-auto-risk-warning-icon {
  flex: none;
  display: inline-flex;
  align-items: center;
  justify-content: center;
  width: 16px;
  height: 16px;
  margin-top: 2px;
  border: 1.5px solid currentColor;
  border-radius: 50%;
  color: var(--dsw-alias-state-error-primary, #e5484d);
  font-size: 11px;
  font-weight: 700;
  line-height: 1;
}
[${DIALOG_ATTRIBUTE}] .dsh-auto-risk-acknowledgement {
  display: flex;
  align-items: flex-start;
  gap: 10px;
  margin-top: 20px;
  color: var(--dsw-alias-label-primary, #171717);
  font-size: 14px;
  line-height: 22px;
  cursor: pointer;
}
[${DIALOG_ATTRIBUTE}] .dsh-auto-risk-acknowledgement input {
  flex: none;
  width: 16px;
  height: 16px;
  margin: 3px 0 0;
  accent-color: var(--dsw-alias-button-primary-fill, #171717);
  cursor: pointer;
}
[${DIALOG_ATTRIBUTE}] .dsh-auto-risk-footer {
  display: flex;
  align-items: center;
  justify-content: flex-end;
  gap: 8px;
  padding: 0 24px;
}
[${DIALOG_ATTRIBUTE}] .dsh-auto-risk-action {
  min-width: 72px;
  min-height: 36px;
  padding: 7px 16px;
  border: 1px solid var(--dsw-alias-border-l2, rgba(0, 0, 0, 0.14));
  border-radius: 12px;
  color: var(--dsw-alias-label-primary, #171717);
  background: transparent;
  font: inherit;
  font-size: 14px;
  cursor: pointer;
}
[${DIALOG_ATTRIBUTE}] .dsh-auto-risk-confirm {
  min-width: 136px;
  border-color: transparent;
  color: var(--dsw-alias-label-on-fill, #fff);
  background: var(--dsw-alias-button-primary-fill, #171717);
}
[${DIALOG_ATTRIBUTE}] .dsh-auto-risk-confirm:disabled {
  color: var(--dsw-alias-label-disable, rgba(255, 255, 255, 0.78));
  background: var(--dsw-alias-button-disabled-fill, #aaa);
  cursor: not-allowed;
}
@supports (height: 100dvh) {
  [${DIALOG_ATTRIBUTE}] .dsh-auto-risk-card {
    max-height: calc(100dvh - 48px);
  }
}
@container (max-width: 460px) {
  [${ICON_ATTRIBUTE}="trigger"] [${LABEL_ATTRIBUTE}] {
    display: none;
  }
}
`;
}
const EN_RISK_COPY = {
    title: 'Enable Auto?',
    description: 'Auto keeps the Full access filesystem scope and adds an automatic policy layer to assess tool calls. This policy is not an operating-system sandbox: classifier mistakes and operations performed by plugins or other code outside the DSH tool pipeline can escape its checks. Only use Auto when you trust the current task, workspace, and installed plugins.',
    acknowledge: 'I understand the risks and want to continue',
    cancel: 'Cancel',
    confirm: 'Enable Auto',
    close: 'Close',
};
const ZH_RISK_COPY = {
    title: '确认启用自动审批？',
    description: '自动审批保留“完全权限”的文件访问范围，并通过自动策略层判断工具调用。该策略不是操作系统级沙箱：分类误判，以及插件或其他代码在 DSH 工具链外执行的操作，仍可能避开检查。仅建议在你信任当前任务、工作区和已安装插件时使用。',
    acknowledge: '我已了解风险，并愿意继续',
    cancel: '取消',
    confirm: '启用自动审批',
    close: '关闭',
};
function riskCopy(document) {
    const language = document.documentElement.lang || document.defaultView?.navigator.language || '';
    return /^zh(?:-|$)/i.test(language) ? ZH_RISK_COPY : EN_RISK_COPY;
}
function makeElement(document, tag, className, text) {
    const element = document.createElement(tag);
    element.className = className;
    if (text !== undefined)
        element.textContent = text;
    return element;
}
/** Build the plugin-owned equivalent of DSH's shared RiskConfirmation dialog. */
function createRiskDialog(document, onCancel, onConfirm) {
    const copy = riskCopy(document);
    const layer = document.createElement('div');
    layer.setAttribute(DIALOG_ATTRIBUTE, '');
    layer.setAttribute('role', 'presentation');
    const mask = makeElement(document, 'div', 'dsh-auto-risk-mask');
    mask.setAttribute('aria-hidden', 'true');
    const card = makeElement(document, 'div', 'dsh-auto-risk-card');
    card.setAttribute('role', 'dialog');
    card.setAttribute('aria-modal', 'true');
    card.setAttribute('aria-label', copy.title);
    const content = makeElement(document, 'div', 'dsh-auto-risk-content');
    const header = makeElement(document, 'div', 'dsh-auto-risk-header');
    const title = makeElement(document, 'h2', 'dsh-auto-risk-title', copy.title);
    const close = makeElement(document, 'button', 'dsh-auto-risk-close', '×');
    close.type = 'button';
    close.setAttribute('aria-label', copy.close);
    header.append(title, close);
    const body = makeElement(document, 'div', 'dsh-auto-risk-body');
    const warning = makeElement(document, 'div', 'dsh-auto-risk-warning');
    const warningIcon = makeElement(document, 'span', 'dsh-auto-risk-warning-icon', '!');
    warningIcon.setAttribute('aria-hidden', 'true');
    warning.append(warningIcon, makeElement(document, 'p', '', copy.description));
    const acknowledgement = makeElement(document, 'label', 'dsh-auto-risk-acknowledgement');
    const checkbox = document.createElement('input');
    checkbox.type = 'checkbox';
    acknowledgement.append(checkbox, document.createTextNode(copy.acknowledge));
    body.append(warning, acknowledgement);
    content.append(header, body);
    const footer = makeElement(document, 'div', 'dsh-auto-risk-footer');
    const cancel = makeElement(document, 'button', 'dsh-auto-risk-action', copy.cancel);
    cancel.type = 'button';
    const confirm = makeElement(document, 'button', 'dsh-auto-risk-action dsh-auto-risk-confirm', copy.confirm);
    confirm.type = 'button';
    confirm.disabled = true;
    footer.append(cancel, confirm);
    card.append(content, footer);
    layer.append(mask, card);
    checkbox.addEventListener('change', () => { confirm.disabled = !checkbox.checked; });
    mask.addEventListener('click', onCancel);
    close.addEventListener('click', onCancel);
    cancel.addEventListener('click', onCancel);
    confirm.addEventListener('click', () => {
        if (confirm.disabled)
            return;
        onConfirm();
    });
    // Keep the still-open official permission menu alive behind the modal. It
    // owns the original selection callback that is replayed after confirmation.
    layer.addEventListener('pointerdown', event => { event.stopPropagation(); });
    queueMicrotask(() => { if (checkbox.isConnected)
        checkbox.focus(); });
    return layer;
}
function normalizedText(element) {
    return (element.textContent ?? '').replace(/\s+/g, ' ').trim();
}
/** Menu gate: a permission menu must contain every preset slot in either locale. */
export function isPermissionMenu(menu) {
    const labels = new Set(Array.from(menu.querySelectorAll('button[role="menuitem"]'), normalizedText));
    return Object.values(PERMISSION_LABEL_SETS).every(variants => variants.some(label => labels.has(label)));
}
function isAutoMenuItem(element) {
    if (element.matches('button[role="menuitem"]') && PERMISSION_LABEL_SETS.auto.includes(normalizedText(element))) {
        const menu = element.closest('[role="menu"]');
        return menu !== null && isPermissionMenu(menu);
    }
    return false;
}
function isAutoPermissionOption(element) {
    if (!element.matches('[role="option"]'))
        return false;
    const listbox = element.closest('[role="listbox"][aria-label]');
    const listboxLabel = listbox?.getAttribute('aria-label') ?? '';
    if (!/^\/permission\s+(?:matches|匹配项)$/i.test(listboxLabel.trim()))
        return false;
    return PERMISSION_LABEL_SETS.auto.includes(normalizedText(element.firstElementChild ?? element));
}
function activeAutoPermissionOption(target) {
    const overlay = target.closest('[aria-label^="/permission"]');
    const overlayLabel = overlay?.getAttribute('aria-label') ?? '';
    if (!/^\/permission\s+(?:options|选项)$/i.test(overlayLabel.trim()))
        return null;
    const option = overlay?.querySelector('[role="listbox"] [role="option"][aria-selected="true"]') ?? null;
    return option !== null && isAutoPermissionOption(option) ? option : null;
}
function isAutoPermissionChoice(element) {
    return isAutoMenuItem(element) || isAutoPermissionOption(element);
}
function isAutoTrigger(element) {
    if (!element.matches('button[aria-label]'))
        return false;
    const label = element.getAttribute('aria-label') ?? '';
    return /(?:访问模式|Access mode)[\s\S]*(?:Auto|自动审批)\s*$/i.test(label);
}
/** The direct text node(s) of an element (used by the settings selector). */
function directText(element) {
    const parts = [];
    for (const node of element.childNodes) {
        if (node.nodeType === 3) {
            const text = node.data.trim();
            if (text)
                parts.push(text);
        }
    }
    return parts.join(' ');
}
/** Build the plugin-owned Auto glyph span (official-style icon element). */
function createAutoGlyph(document, size) {
    const span = document.createElement('span');
    span.className = 'dsa-autoIcon' + (size === 'trigger' ? ' dsa-autoIconTrigger' : '');
    span.setAttribute('aria-hidden', 'true');
    span.innerHTML = `<svg width="${size}" height="${size}" viewBox="0 0 16 16" fill="none" xmlns="http://www.w3.org/2000/svg" aria-hidden="true"><path d="${SHIELD_PATH}" stroke="currentColor" stroke-width="1.31831" stroke-linejoin="round"/><path d="${BOLT_PATH}" fill="currentColor"/></svg>`;
    return span;
}
/**
 * Insert the glyph span and localize the label of one auto surface.
 * The glyph only joins surfaces where the official UI renders permission
 * glyphs (menu items, the composer trigger); the popup rows and settings
 * selector are label-only, matching the official /permission surfaces.
 */
function decorateSurface(document, container, label, kind) {
    if (kind !== 'option' && container.querySelector('.dsa-autoIcon') === null) {
        const glyph = createAutoGlyph(document, kind === 'trigger' ? 14 : 16);
        // Mirror official ordering: glyph first, then the label element.
        container.insertBefore(glyph, container.firstChild);
    }
    if (label === null)
        return;
    label.setAttribute(LABEL_ATTRIBUTE, '');
    const text = autoName(document);
    if (label.textContent !== text)
        label.textContent = text;
}
/** Localize the settings PermissionRow selector text node (official has no glyph there). */
function decorateSelector(document, button) {
    if (directText(button) === 'Auto' || directText(button) === '自动审批') {
        const text = autoName(document);
        for (const node of button.childNodes) {
            if (node.nodeType === 3 && node.data.trim() !== '') {
                if (node.data !== text)
                    node.data = text;
                break;
            }
        }
        button.setAttribute(LABEL_ATTRIBUTE, '');
    }
}
/** Mark + decorate the official Auto permission rows, trigger, and settings selector. */
export function decorateAutoPermissionIcons(document) {
    const autoNames = PERMISSION_LABEL_SETS.auto;
    for (const marked of document.querySelectorAll(`[${ICON_ATTRIBUTE}]`)) {
        const kind = marked.getAttribute(ICON_ATTRIBUTE);
        if ((kind === 'menu' && !isAutoMenuItem(marked)) || (kind === 'trigger' && !isAutoTrigger(marked))) {
            // The official UI keeps the trigger/menu DOM node across mode
            // switches and re-renders its children in place, so an abandoned
            // glyph span would linger until reload.
            marked.removeAttribute(ICON_ATTRIBUTE);
            for (const glyph of Array.from(marked.children).filter(child => child.classList?.contains('dsa-autoIcon'))) {
                glyph.remove();
            }
            for (const label of marked.querySelectorAll(`[${LABEL_ATTRIBUTE}]`)) {
                label.removeAttribute(LABEL_ATTRIBUTE);
            }
        }
    }
    for (const menu of document.querySelectorAll('[role="menu"]')) {
        if (!isPermissionMenu(menu))
            continue;
        // The composer permission menu draws an official item glyph on every
        // preset row; the settings "权限" selector dropdown is label-only.
        // Join the Auto glyph only where the official UI draws glyphs and keep
        // the label-only surface as plain text (localization still applies).
        let drawsGlyphs = false;
        for (const other of menu.querySelectorAll('button[role="menuitem"]')) {
            if (!autoNames.includes(normalizedText(other)) && other.querySelector('svg') !== null) {
                drawsGlyphs = true;
                break;
            }
        }
        for (const item of menu.querySelectorAll('button[role="menuitem"]')) {
            if (!autoNames.includes(normalizedText(item)))
                continue;
            // Label span = a text-carrying span without an embedded glyph/check.
            const label = Array.from(item.children).find(child => child.tagName === 'SPAN' && child.querySelector('svg') === null && autoNames.includes(normalizedText(child))) ?? null;
            if (drawsGlyphs) {
                item.setAttribute(ICON_ATTRIBUTE, 'menu');
                decorateSurface(document, item, label, 'menu');
            }
            else {
                // Label-only menu: drop any previously injected glyph/marker
                // (an earlier scan or an older bundle may have left one) and
                // localize the label without an icon.
                item.removeAttribute(ICON_ATTRIBUTE);
                for (const glyph of Array.from(item.children).filter(child => child.classList?.contains('dsa-autoIcon'))) {
                    glyph.remove();
                }
                if (label !== null)
                    decorateSurface(document, item, label, 'option');
            }
        }
    }
    for (const button of document.querySelectorAll('button[aria-label]')) {
        if (isAutoTrigger(button)) {
            button.setAttribute(ICON_ATTRIBUTE, 'trigger');
            const label = Array.from(button.children).find(child => child.tagName === 'SPAN' && child.querySelector('svg') === null && autoNames.includes(normalizedText(child))) ?? null;
            decorateSurface(document, button, label, 'trigger');
            const aria = button.getAttribute('aria-label') ?? '';
            const localized = aria.replace(/(?:Auto|自动审批)\s*$/i, autoName(document));
            if (localized !== aria)
                button.setAttribute('aria-label', localized);
        }
    }
    // /permission popup rows (listbox 匹配项 rows under the 选项 overlay).
    for (const listbox of document.querySelectorAll('[role="listbox"][aria-label]')) {
        const listboxLabel = listbox.getAttribute('aria-label') ?? '';
        if (!/^\/permission\s+(?:matches|匹配项)$/i.test(listboxLabel.trim()))
            continue;
        for (const option of listbox.querySelectorAll('[role="option"]')) {
            const label = option.firstElementChild && option.firstElementChild.tagName === 'SPAN'
                ? option.firstElementChild
                : null;
            if (label === null || !autoNames.includes(normalizedText(label)))
                continue;
            decorateSurface(document, option, label, 'option');
        }
    }
    // Settings PermissionRow selector (bare text node + chevron).
    for (const button of document.querySelectorAll('button[aria-haspopup="menu"]')) {
        if (button.getAttribute('aria-label') !== null)
            continue;
        if (directText(button) === 'Auto' || directText(button) === '自动审批')
            decorateSelector(document, button);
    }
    // Sweep abandoned glyphs: a mode switch whose marker was already dropped
    // by an earlier scan still leaves the injected span attached to the
    // re-rendered trigger. Any glyph outside a currently valid marked surface
    // is stale and must go.
    for (const glyph of document.querySelectorAll('.dsa-autoIcon')) {
        const owner = glyph.parentElement;
        if (owner === null)
            continue;
        const kind = owner.getAttribute(ICON_ATTRIBUTE);
        const valid = kind === 'menu' ? isAutoMenuItem(owner) : kind === 'trigger' ? isAutoTrigger(owner) : false;
        if (!valid)
            glyph.remove();
    }
}
/** Install the Auto icon and explicit risk gate, then return their disposer. */
export function installAutoPermissionIcon(document) {
    for (const existing of document.querySelectorAll('style[data-plugin]')) {
        if (existing.getAttribute('data-plugin') === PLUGIN_ID)
            existing.remove();
    }
    const style = document.createElement('style');
    style.dataset.plugin = PLUGIN_ID;
    style.dataset.pluginCss = `${PLUGIN_ID}/permission-icon`;
    style.textContent = iconStyles();
    document.head.appendChild(style);
    let active = true;
    let queued = false;
    const scan = () => {
        if (!active || queued)
            return;
        queued = true;
        queueMicrotask(() => {
            queued = false;
            if (active)
                decorateAutoPermissionIcons(document);
        });
    };
    decorateAutoPermissionIcons(document);
    const observer = new MutationObserver(scan);
    observer.observe(document.documentElement, {
        attributes: true,
        attributeFilter: ['aria-label', 'lang'],
        characterData: true,
        childList: true,
        subtree: true,
    });
    const bypassed = new WeakSet();
    let dialog = null;
    const closeDialog = () => {
        dialog?.remove();
        dialog = null;
    };
    const dismissDialog = () => {
        if (dialog === null)
            return;
        closeDialog();
        // Mirror the official flow: cancelling the acknowledgement also dismisses
        // the menu or /permission popup that remains mounted behind the modal.
        const MouseEvent = document.defaultView?.MouseEvent;
        if (MouseEvent !== undefined) {
            document.body.dispatchEvent(new MouseEvent('pointerdown', { bubbles: true }));
        }
    };
    const openDialog = (item) => {
        if (dialog !== null)
            return;
        dialog = createRiskDialog(document, dismissDialog, () => {
            closeDialog();
            if (!item.isConnected)
                return;
            bypassed.add(item);
            item.click();
        });
        document.body.appendChild(dialog);
    };
    const onClick = (event) => {
        const target = event.target;
        if (!(target instanceof Element))
            return;
        const item = target.closest('button[role="menuitem"], [role="option"]');
        if (item === null || !isAutoPermissionChoice(item))
            return;
        if (bypassed.has(item)) {
            bypassed.delete(item);
            return;
        }
        event.preventDefault();
        event.stopPropagation();
        event.stopImmediatePropagation();
        openDialog(item);
    };
    const onPointerDown = (event) => {
        const target = event.target;
        if (dialog === null || !(target instanceof Node) || !dialog.contains(target))
            return;
        // DSH's /permission popup dismisses outside pointer presses from a later
        // document-capture listener. Hold it open so its original row can be
        // replayed after acknowledgement.
        event.stopImmediatePropagation();
    };
    const onKeyDown = (event) => {
        if (event.key === 'Escape' && dialog !== null) {
            event.preventDefault();
            event.stopImmediatePropagation();
            dismissDialog();
            return;
        }
        if (event.key !== 'Enter' || dialog !== null || !(event.target instanceof Element))
            return;
        const option = activeAutoPermissionOption(event.target);
        if (option === null)
            return;
        event.preventDefault();
        event.stopImmediatePropagation();
        openDialog(option);
    };
    document.addEventListener('click', onClick, true);
    document.addEventListener('pointerdown', onPointerDown, true);
    document.addEventListener('keydown', onKeyDown, true);
    return () => {
        active = false;
        observer.disconnect();
        document.removeEventListener('click', onClick, true);
        document.removeEventListener('pointerdown', onPointerDown, true);
        document.removeEventListener('keydown', onKeyDown, true);
        closeDialog();
        style.remove();
        // Remove injected glyphs and restore the configured official labels.
        for (const glyph of document.querySelectorAll('.dsa-autoIcon')) {
            glyph.remove();
        }
        for (const labelled of document.querySelectorAll(`[${LABEL_ATTRIBUTE}]`)) {
            labelled.removeAttribute(LABEL_ATTRIBUTE);
            if (labelled.tagName === 'SPAN') {
                if (labelled.textContent !== CONFIGURED_AUTO_NAME)
                    labelled.textContent = CONFIGURED_AUTO_NAME;
            }
            else if (directText(labelled) === '自动审批') {
                for (const node of labelled.childNodes) {
                    if (node.nodeType === 3 && node.data.trim() !== '') {
                        node.data = CONFIGURED_AUTO_NAME;
                        break;
                    }
                }
            }
        }
        for (const marked of document.querySelectorAll(`[${ICON_ATTRIBUTE}]`)) {
            marked.removeAttribute(ICON_ATTRIBUTE);
        }
        // Restore the trigger aria-label the decorate pass localized.
        for (const button of document.querySelectorAll('button[aria-label]')) {
            const label = button.getAttribute('aria-label') ?? '';
            if (/访问模式，当前：自动审批$/.test(label)) {
                button.setAttribute('aria-label', label.replace(/(?:Auto|自动审批)\s*$/, CONFIGURED_AUTO_NAME));
            }
        }
    };
}