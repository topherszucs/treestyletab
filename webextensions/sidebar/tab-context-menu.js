/*
# This Source Code Form is subject to the terms of the Mozilla Public
# License, v. 2.0. If a copy of the MPL was not distributed with this
# file, You can obtain one at http://mozilla.org/MPL/2.0/.
*/
'use strict';

import MenuUI from '/extlib/MenuUI.js';

import {
  log as internalLogger,
  wait,
  configs
} from '/common/common.js';
import * as Constants from '/common/constants.js';
import * as ApiTabs from '/common/api-tabs.js';
import * as TabsStore from '/common/tabs-store.js';
import * as TSTAPI from '/common/tst-api.js';
import * as EventUtils from './event-utils.js';
import * as BackgroundConnection from './background-connection.js';

import Tab from '/common/Tab.js';

import EventListenerManager from '/extlib/EventListenerManager.js';

function log(...args) {
  internalLogger('sidebar/tab-context-menu', ...args);
}

export const onTabsClosing = new EventListenerManager();

let mUI;
let mMenu;

let mContextTab      = null;
let mLastOpenOptions = null;
let mIsDirty         = false;

const mExtraItems = new Map();

export function init() {
  mMenu = document.querySelector('#tabContextMenu');
  document.addEventListener('contextmenu', onContextMenu, { capture: true });

  mUI = new MenuUI({
    root: mMenu,
    onCommand,
    //onShown,
    onHidden,
    appearance:        'menu',
    animationDuration: configs.animation ? configs.collapseDuration : 0.001,
    subMenuOpenDelay:  configs.subMenuOpenDelay,
    subMenuCloseDelay: configs.subMenuCloseDelay
  });

  browser.runtime.onMessage.addListener(onMessage);
  browser.runtime.onMessageExternal.addListener(onExternalMessage);

  browser.runtime.sendMessage({
    type: TSTAPI.kCONTEXT_MENU_GET_ITEMS
  }).then(items => {
    importExtraItems(items);
    mIsDirty = true;
  }).catch(ApiTabs.createErrorSuppressor());
}

async function rebuild() {
  if (!mIsDirty)
    return;

  mIsDirty = false;

  const firstExtraItem = mMenu.querySelector('.extra, .imitated');
  if (firstExtraItem) {
    const range = document.createRange();
    range.selectNodeContents(mMenu);
    range.setStartBefore(firstExtraItem);
    range.deleteContents();
    range.detach();
  }

  if (mExtraItems.size == 0)
    return;

  const extraItemNodes = document.createDocumentFragment();
  const incognitoParams = { windowId: TabsStore.getWindow() };
  for (const [id, extraItems] of mExtraItems.entries()) {
    if (!TSTAPI.isSafeAtIncognito(id, incognitoParams))
      continue;
    let addonItem = document.createElement('li');
    const name = getAddonName(id);
    addonItem.appendChild(document.createTextNode(name));
    addonItem.setAttribute('title', name);
    addonItem.classList.add('extra');
    const icon = getAddonIcon(id);
    if (icon)
      addonItem.dataset.icon = icon;
    prepareAsSubmenu(addonItem);

    const toBeBuiltItems = [];
    for (const item of extraItems) {
      if (item.visible === false)
        continue;
      if (item.contexts && !item.contexts.includes('tab'))
        continue;
      if (item.documentUrlPatterns &&
          (!item.viewTypes ||
           !item.viewTypes.includes('sidebar') ||
           item.documentUrlPatterns.some(pattern => !/^moz-extension:/.test(pattern)) ||
           !matchesToPattern(location.href, item.documentUrlPatterns)) &&
          mContextTab &&
          !matchesToPattern(mContextTab.url, item.documentUrlPatterns))
        continue;
      toBeBuiltItems.push(item);
    }
    const topLevelItems = toBeBuiltItems.filter(item => !item.parentId);
    if (topLevelItems.length == 1 &&
        !topLevelItems[0].icons)
      topLevelItems[0].icons = TSTAPI.getAddon(id).icons || {};

    const addonSubMenu = addonItem.lastChild;
    const knownItems   = {};
    for (const item of toBeBuiltItems) {
      const itemNode = buildExtraItem(item, id);
      if (item.parentId) {
        if (item.parentId in knownItems) {
          const parent = knownItems[item.parentId];
          prepareAsSubmenu(parent);
          parent.lastChild.appendChild(itemNode);
        }
        else {
          continue;
        }
      }
      else {
        addonSubMenu.appendChild(itemNode);
      }
      knownItems[item.id] = itemNode;
    }
    if (id == browser.runtime.id) {
      for (const item of addonSubMenu.children) {
        if (!item.nextSibling) // except the last "Tree Style Tab" menu
          continue;
        item.classList.remove('extra');
        item.classList.add('imitated');
      }
      const range = document.createRange();
      range.selectNodeContents(addonSubMenu);
      extraItemNodes.appendChild(range.extractContents());
      range.detach();
      continue;
    }
    switch (addonSubMenu.childNodes.length) {
      case 0:
        break;
      case 1:
        addonItem = addonSubMenu.removeChild(addonSubMenu.firstChild);
        extraItemNodes.appendChild(addonItem);
      default:
        extraItemNodes.appendChild(addonItem);
        break;
    }
  }
  if (!extraItemNodes.hasChildNodes())
    return;

  mMenu.appendChild(extraItemNodes);
}

function getAddonName(id) {
  if (id == browser.runtime.id)
    return browser.i18n.getMessage('extensionName');
  const addon = TSTAPI.getAddon(id) || {};
  return addon.name || id.replace(/@.+$/, '');
}

function getAddonIcon(id) {
  const addon = TSTAPI.getAddon(id) || {};
  return chooseIconForAddon({
    id:         id,
    internalId: addon.internalId,
    icons:      addon.icons || {}
  });
}

function chooseIconForAddon(params) {
  const icons = params.icons || {};
  const addon = TSTAPI.getAddon(params.id) || {};
  let sizes = Object.keys(icons).map(aSize => parseInt(aSize)).sort();
  const reducedSizes = sizes.filter(aSize => aSize < 16);
  if (reducedSizes.length > 0)
    sizes = reducedSizes;
  const size = sizes[0] || null;
  if (!size)
    return null;
  let url = icons[size];
  if (!/^\w+:\/\//.test(url))
    url = `moz-extension://${addon.internalId || params.internalId}/${url.replace(/^\//, '')}`;
  return url;
}

function prepareAsSubmenu(itemNode) {
  if (itemNode.querySelector('ul'))
    return itemNode;
  itemNode.appendChild(document.createElement('ul'));
  return itemNode;
}

function buildExtraItem(item, ownerAddonId) {
  const itemNode = document.createElement('li');
  itemNode.setAttribute('id', `${ownerAddonId}-${item.id}`);
  itemNode.setAttribute('data-item-id', item.id);
  itemNode.setAttribute('data-item-owner-id', ownerAddonId);
  itemNode.classList.add('extra');
  itemNode.classList.add(item.type || 'normal');
  if (item.type == 'checkbox' || item.type == 'radio') {
    if (item.checked)
      itemNode.classList.add('checked');
  }
  if (item.type != 'separator') {
    itemNode.appendChild(document.createTextNode(item.title));
    itemNode.setAttribute('title', item.title);
  }
  if (item.enabled === false)
    itemNode.classList.add('disabled');
  else
    itemNode.classList.remove('disabled');;
  const addon = TSTAPI.getAddon(ownerAddonId) || {};
  const icon = chooseIconForAddon({
    id:         ownerAddonId,
    internalId: addon.internalId,
    icons:      item.icons || {}
  });
  if (icon)
    itemNode.dataset.icon = icon;
  return itemNode;
}

function matchesToPattern(url, patterns) {
  if (!Array.isArray(patterns))
    patterns = [patterns];
  for (const pattern of patterns) {
    if (matchPatternToRegExp(pattern).test(url))
      return true;
  }
  return false;
}
// https://developer.mozilla.org/en-US/Add-ons/WebExtensions/Match_patterns
const matchPattern = /^(?:(\*|http|https|file|ftp|app|moz-extension):\/\/([^\/]+|)\/?(.*))$/i;
function matchPatternToRegExp(pattern) {
  if (pattern === '<all_urls>')
    return (/^(?:https?|file|ftp|app):\/\//);
  const match = matchPattern.exec(pattern);
  if (!match)
    throw new TypeError(`"${pattern}" is not a valid MatchPattern`);

  const [, scheme, host, path,] = match;
  return new RegExp('^(?:'
                    + (scheme === '*' ? 'https?' : escape(scheme)) + ':\\/\\/'
                    + (host === '*' ? '[^\\/]*' : escape(host).replace(/^\*\./g, '(?:[^\\/]+)?'))
                    + (path ? (path == '*' ? '(?:\\/.*)?' : ('\\/' + escape(path).replace(/\*/g, '.*'))) : '\\/?')
                    + ')$');
}

export async function open(options = {}) {
  await close();
  mLastOpenOptions = options;
  mContextTab      = options.tab && Tab.get(options.tab.id);
  await rebuild();
  if (mIsDirty) {
    return await open(options);
  }
  applyContext();
  const originalCanceller = options.canceller;
  options.canceller = () => {
    return (typeof originalCanceller == 'function' && originalCanceller()) || mIsDirty;
  };
  await mUI.open(options);
  if (mIsDirty) {
    return await open(options);
  }
}

export async function close() {
  await mUI.close();
  mMenu.removeAttribute('data-tab-id');
  mMenu.removeAttribute('data-tab-states');
  mContextTab      = null;
  mLastOpenOptions = null;
}

function applyContext() {
  if (mContextTab) {
    mMenu.setAttribute('data-tab-id', mContextTab.id);
    const states = [];
    if (mContextTab.active)
      states.push('active');
    if (mContextTab.pinned)
      states.push('pinned');
    if (mContextTab.audible)
      states.push('audible');
    if (mContextTab.$TST.muted)
      states.push('muted');
    if (mContextTab.discarded)
      states.push('discarded');
    if (mContextTab.incognito)
      states.push('incognito');
    if (mContextTab.$TST.multiselected)
      states.push('multiselected');
    mMenu.setAttribute('data-tab-states', states.join(' '));
  }
}

async function onCommand(item, event) {
  if (event.button == 1)
    return;

  const contextTab = mContextTab;
  wait(0).then(() => close()); // close the menu immediately!

  const id = item.getAttribute('data-item-id');
  if (!id)
    return;

  const modifiers = [];
  if (event.metaKey)
    modifiers.push('Command');
  if (event.ctrlKey) {
    modifiers.push('Ctrl');
    if (/^Mac/i.test(navigator.platform))
      modifiers.push('MacCtrl');
  }
  if (event.shiftKey)
    modifiers.push('Shift');
  const owner      = item.getAttribute('data-item-owner-id');
  const checked    = item.matches('.radio, .checkbox:not(.checked)');
  const wasChecked = item.matches('.radio.checked, .checkbox.checked');
  const tab        = contextTab && (await (new TSTAPI.TreeItem(contextTab, { isContextTab: true })).exportFor(owner)) || null
  const message = {
    type: TSTAPI.kCONTEXT_MENU_CLICK,
    info: {
      checked,
      editable:         false,
      frameUrl:         null,
      linkUrl:          null,
      mediaType:        null,
      menuItemId:       id,
      modifiers:        modifiers,
      pageUrl:          null,
      parentMenuItemId: null,
      selectionText:    null,
      srcUrl:           null,
      wasChecked
    },
    tab
  };
  if (owner == browser.runtime.id)
    await browser.runtime.sendMessage(message).catch(ApiTabs.createErrorSuppressor());
  else if (TSTAPI.isSafeAtIncognito(owner, { tab: contextTab, windowId: TabsStore.getWindow() }))
    await browser.runtime.sendMessage(owner, message).catch(ApiTabs.createErrorSuppressor());

  if (item.matches('.checkbox')) {
    item.classList.toggle('checked');
    for (const itemData of mExtraItems.get(item.dataset.itemOwnerId)) {
      if (itemData.id != item.dataset.itemId)
        continue;
      itemData.checked = item.matches('.checked');
      browser.runtime.sendMessage({
        type:    TSTAPI.kCONTEXT_ITEM_CHECKED_STATUS_CHANGED,
        id:      item.dataset.itemId,
        ownerId: item.dataset.itemOwnerId,
        checked: itemData.checked
      }).catch(ApiTabs.createErrorSuppressor());
      break;
    }
    mIsDirty = true;
  }
  else if (item.matches('.radio')) {
    const currentRadioItems = new Set();
    let radioItems = null;
    for (const itemData of mExtraItems.get(item.dataset.itemOwnerId)) {
      if (itemData.type == 'radio') {
        currentRadioItems.add(itemData);
      }
      else if (radioItems == currentRadioItems) {
        break;
      }
      else {
        currentRadioItems.clear();
      }
      if (itemData.id == item.dataset.itemId)
        radioItems = currentRadioItems;
    }
    if (radioItems) {
      for (const itemData of radioItems) {
        itemData.checked = itemData.id == item.dataset.itemId;
        const radioItem = document.getElementById(`${item.dataset.itemOwnerId}-${itemData.id}`);
        if (radioItem) {
          if (itemData.checked)
            radioItem.classList.add('checked');
          else
            radioItem.classList.remove('checked');
        }
        browser.runtime.sendMessage({
          type:    TSTAPI.kCONTEXT_ITEM_CHECKED_STATUS_CHANGED,
          id:      item.dataset.itemId,
          ownerId: item.dataset.itemOwnerId,
          checked: itemData.checked
        }).catch(ApiTabs.createErrorSuppressor());
      }
    }
    mIsDirty = true;
  }
}

async function onShown(contextTab) {
  contextTab = contextTab || mContextTab
  const message = {
    type: TSTAPI.kCONTEXT_MENU_SHOWN,
    info: {
      editable:         false,
      frameUrl:         null,
      linkUrl:          null,
      mediaType:        null,
      pageUrl:          null,
      selectionText:    null,
      srcUrl:           null,
      contexts:         ['tab'],
      menuIds:          [],
      viewType:         'sidebar'
    },
    tab: contextTab && new TSTAPI.TreeItem(contextTab, { isContextTab: true }) || null,
    windowId: TabsStore.getWindow()
  };
  return Promise.all([
    browser.runtime.sendMessage(Object.assign({}, message, {
      tab: message.tab && await message.tab.exportFor(browser.runtime.id)
    })).catch(ApiTabs.createErrorSuppressor()),
    TSTAPI.sendMessage(message, { tabProperties: ['tab'] })
  ]);
}

async function onHidden() {
  const message = {
    type: TSTAPI.kCONTEXT_MENU_HIDDEN,
    windowId: TabsStore.getWindow()
  };
  return Promise.all([
    browser.runtime.sendMessage(message).catch(ApiTabs.createErrorSuppressor()),
    TSTAPI.sendMessage(message)
  ]);
}

function onMessage(message, _sender) {
  log('tab-context-menu: internally called:', message);
  switch (message.type) {
    case Constants.kCOMMAND_NOTIFY_TABS_CLOSING:
      // Don't respond to message for other windows, because
      // the sender receives only the firstmost response.
      if (message.windowId != TabsStore.getWindow())
        return;
      return Promise.resolve(onTabsClosing.dispatch(message.tabs));

    case TSTAPI.kCONTEXT_MENU_UPDATED: {
      importExtraItems(message.items);
      mIsDirty = true;
      if (mUI.opened)
        open(mLastOpenOptions);
    }; break;
  }
}

function importExtraItems(importedItems) {
  mExtraItems.clear();
  for (const [id, items] of Object.entries(importedItems)) {
    mExtraItems.set(id, items);
  }
}

function onExternalMessage(message, sender) {
  log('API called:', message, { id: sender.id, url: sender.url });
  switch (message.type) {
    case TSTAPI.kCONTEXT_MENU_OPEN:
      return (async () => {
        const tab      = message.tab ? Tab.get(message.tab) : null ;
        const windowId = message.window || tab && tab.windowId;
        if (windowId != TabsStore.getWindow())
          return;
        await onShown(tab);
        await wait(25);
        return open({
          tab,
          left:     message.left,
          top:      message.top
        });
      })();
  }
}


async function onContextMenu(event) {
  if (EventUtils.getElementTarget(event).closest('input, textarea'))
    return;

  const tab = EventUtils.getTabFromEvent(event);
  const modifierKeyPressed = /^Mac/i.test(navigator.platform) ? event.metaKey : event.ctrlKey;
  if (tab &&
      !modifierKeyPressed &&
      typeof browser.menus.overrideContext == 'function') {
    browser.menus.overrideContext({
      context: 'tab',
      tabId: tab.id
    });
    return;
  }
  if (!configs.emulateDefaultContextMenu)
    return;
  event.stopPropagation();
  event.preventDefault();
  await onShown(tab);
  await wait(25);
  await open({
    tab,
    left: event.clientX,
    top:  event.clientY
  });
}

BackgroundConnection.onMessage.addListener(async message => {
  switch (message.type) {
    case Constants.kCOMMAND_NOTIFY_TAB_CREATED:
    case Constants.kCOMMAND_NOTIFY_TAB_MOVED:
    case Constants.kCOMMAND_NOTIFY_TAB_REMOVING:
    case Constants.kCOMMAND_NOTIFY_TAB_ACTIVATED:
    case Constants.kCOMMAND_NOTIFY_TAB_PINNED:
    case Constants.kCOMMAND_NOTIFY_TAB_UNPINNED:
    case Constants.kCOMMAND_NOTIFY_TAB_SHOWN:
    case Constants.kCOMMAND_NOTIFY_TAB_HIDDEN:
    case Constants.kCOMMAND_NOTIFY_CHILDREN_CHANGED:
      close();
      break;
  }
});
