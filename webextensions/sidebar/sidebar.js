/*
# This Source Code Form is subject to the terms of the Mozilla Public
# License, v. 2.0. If a copy of the MPL was not distributed with this
# file, You can obtain one at http://mozilla.org/MPL/2.0/.
*/
'use strict';

import RichConfirm from '../extlib/RichConfirm.js';
import TabIdFixer from '../extlib/TabIdFixer.js';

import {
  log as internalLogger,
  nextFrame,
  configs
} from '../common/common.js';
import * as Constants from '../common/constants.js';
import * as ApiTabsListener from '../common/api-tabs-listener.js';
import * as Tabs from '../common/tabs.js';
import * as TabsInternalOperation from '../common/tabs-internal-operation.js';
import * as TabsUpdate from '../common/tabs-update.js';
import * as TabsMove from '../common/tabs-move.js';
import * as TabsContainer from '../common/tabs-container.js';
import * as Tree from '../common/tree.js';
import * as TSTAPI from '../common/tst-api.js';
import * as ContextualIdentities from '../common/contextual-identities.js';
import * as Commands from '../common/commands.js';
import * as UserOperationBlocker from '../common/user-operation-blocker.js';
import * as MetricsData from '../common/metrics-data.js';
import EventListenerManager from '../common/EventListenerManager.js';

import * as SidebarCache from './sidebar-cache.js';
import * as SidebarTabs from './sidebar-tabs.js';
import * as PinnedTabs from './pinned-tabs.js';
import * as DragAndDrop from './drag-and-drop.js';
import * as RestoringTabCount from './restoring-tab-count.js';
import * as Size from './size.js';
import * as Color from './color.js';
import * as Indent from './indent.js';
import * as Scroll from './scroll.js';
import * as TabContextMenu from './tab-context-menu.js';

function log(...aArgs) {
  if (configs.logFor['sidebar/sidebar'])
    internalLogger(...aArgs);
}

export const onInit    = new EventListenerManager();
export const onBuilt   = new EventListenerManager();
export const onReady   = new EventListenerManager();


let gStyle;
let gTargetWindow = null;

const gTabBar                     = document.querySelector('#tabbar');
const gAfterTabsForOverflowTabBar = document.querySelector('#tabbar ~ .after-tabs');
const gStyleLoader                = document.querySelector('#style-loader');
const gBrowserThemeDefinition     = document.querySelector('#browser-theme-definition');
const gUserStyleRules             = document.querySelector('#user-style-rules');
const gContextualIdentitiesStyle  = document.querySelector('#contextual-identity-styling');

{ // apply style ASAP!
  // allow customiation for platform specific styles with selectors like `:root[data-user-agent*="Windows NT 10"]`
  document.documentElement.dataset.userAgent = navigator.userAgent;

  const style = location.search.match(/style=([^&]+)/);
  if (style)
    applyStyle(style[1]);
  else
    configs.$loaded.then(() => applyStyle());

  configs.$loaded.then(applyUserStyleRules);
}

UserOperationBlocker.block({ throbber: true });

export async function init() {
  MetricsData.add('init start');
  log('initialize sidebar on load');

  await Promise.all([
    (async () => {
      const apiTabs = await browser.tabs.query({
        active:        true,
        currentWindow: true
      });
      gTargetWindow = apiTabs[0].windowId;
      Tabs.setWindow(gTargetWindow);
      log.context   = `Sidebar-${gTargetWindow}`;

      PinnedTabs.init();
      Indent.init();
      SidebarCache.init();
      SidebarCache.onRestored.addListener(DragAndDrop.clearDropPosition);
    })(),
    configs.$loaded
  ]);
  MetricsData.add('browser.tabs.query, configs.$loaded');

  onConfigChange('colorScheme');
  onConfigChange('simulateSVGContextFill');
  onInit.dispatch();

  await Promise.all([
    waitUntilBackgroundIsReady(),
    ContextualIdentities.init()
  ]);
  MetricsData.add('applyStyle, waitUntilBackgroundIsReady and ContextualIdentities.init');

  let cachedContents;
  let restoredFromCache;
  await MetricsData.addAsync('parallel initialization tasks', Promise.all([
    MetricsData.addAsync('main', async () => {
      if (configs.useCachedTree)
        await MetricsData.addAsync('read cached sidebar contents', async () => {
          cachedContents = await SidebarCache.getEffectiveWindowCache();
        });

      restoredFromCache = await rebuildAll(cachedContents && cachedContents.tabbar);
      ApiTabsListener.startListen();

      browser.runtime.connect({
        name: `${Constants.kCOMMAND_REQUEST_CONNECT_PREFIX}${gTargetWindow}`
      });
      if (browser.theme && browser.theme.getCurrent) // Firefox 58 and later
        browser.theme.getCurrent(gTargetWindow).then(applyBrowserTheme);
      else
        applyBrowserTheme();

      if (!restoredFromCache)
        await MetricsData.addAsync('inheritTreeStructure', async () => {
          await inheritTreeStructure();
        });

      configs.$addObserver(onConfigChange);
      onConfigChange('debug');
      onConfigChange('sidebarPosition');
      onConfigChange('sidebarDirection');
      onConfigChange('sidebarScrollbarPosition');
      onConfigChange('scrollbarMode');
      onConfigChange('showContextualIdentitiesSelector');
      onConfigChange('showNewTabActionSelector');

      document.addEventListener('focus', onFocus);
      document.addEventListener('blur', onBlur);
      window.addEventListener('resize', onResize);
      gTabBar.addEventListener('transitionend', onTransisionEnd);

      if (browser.theme && browser.theme.onUpdated) // Firefox 58 and later
        browser.theme.onUpdated.addListener(onBrowserThemeChanged);

      browser.runtime.onMessage.addListener(onMessage);

      onBuilt.dispatch();

      DragAndDrop.init();

      MetricsData.add('onBuilt: start to listen events');
    }),
    MetricsData.addAsync('Size.init', async () => {
      Size.init();
      document.documentElement.classList.remove('initializing');
    }),
    MetricsData.addAsync('initializing contextual identities', async () => {
      updateContextualIdentitiesStyle();
      updateContextualIdentitiesSelector();
      ContextualIdentities.startObserve();
    }),
    MetricsData.addAsync('TabContextMenu.init', async () => {
      TabContextMenu.init();
    }),
    MetricsData.addAsync('getting registered addons and scroll lock state', async () => {
      await TSTAPI.initAsFrontend();
    }),
    MetricsData.addAsync('Scroll.init', async () => {
      Scroll.init();
    })
  ]));

  SidebarCache.startTracking();
  Indent.updateRestoredTree(cachedContents && cachedContents.indent);
  if (!restoredFromCache) {
    SidebarTabs.updateAll();
    SidebarCache.reserveToUpdateCachedTabbar();
  }
  updateTabbarLayout({ justNow: true });

  SidebarTabs.init();

  onConfigChange('animation');
  onReady.dispatch();

  UserOperationBlocker.unblock({ throbber: true });

  MetricsData.add('init end');
  log(`Startup metrics for ${Tabs.getTabs().length} tabs: `, MetricsData.toString());
}

function applyStyle(aStyle) {
  gStyle = aStyle || configs.style;
  switch (gStyle) {
    case 'metal':
      gStyleLoader.setAttribute('href', 'styles/metal/metal.css');
      break;
    case 'sidebar':
      gStyleLoader.setAttribute('href', 'styles/sidebar/sidebar.css');
      break;
    case 'mixed':
      gStyleLoader.setAttribute('href', 'styles/square/mixed.css');
      break;
    case 'vertigo':
      gStyleLoader.setAttribute('href', 'styles/square/vertigo.css');
      break;
    case 'plain-dark':
      gStyleLoader.setAttribute('href', 'styles/square/plain-dark.css');
      break;
    case 'plain':
    case 'flat': // for backward compatibility, fall back to plain.
      gStyleLoader.setAttribute('href', 'styles/square/plain.css');
      break;
    case 'highcontrast':
      gStyleLoader.setAttribute('href', 'styles/square/highcontrast.css');
      break;
    default:
      // as the base of customization. see also:
      // https://github.com/piroor/treestyletab/issues/1604
      gStyleLoader.setAttribute('href', 'data:text/css,');
      break;
  }
  return new Promise((aResolve, _aReject) => {
    gStyleLoader.addEventListener('load', () => {
      nextFrame().then(aResolve);
    }, { once: true });
  });
}

function applyUserStyleRules() {
  gUserStyleRules.textContent = configs.userStyleRules || '';
}

function applyBrowserTheme(aTheme) {
  log('applying theme ', aTheme);

  const baseColor = Color.parseCSSColor(window.getComputedStyle(document.querySelector('#dummy-favicon-size-box'), null).backgroundColor);
  const highlightColor = Color.parseCSSColor(window.getComputedStyle(document.querySelector('#dummy-highlight-color-box'), null).backgroundColor);
  const defaultColors = `:root {
    --face-highlight-lighter: ${Color.mixCSSColors(baseColor, Object.assign({}, highlightColor, { alpha: 0.35 }),)};
    --face-highlight-more-lighter: ${Color.mixCSSColors(baseColor, Object.assign({}, highlightColor, { alpha: 0.2 }))};
    --face-highlight-more-more-lighter: ${Color.mixCSSColors(baseColor, Object.assign({}, highlightColor, { alpha: 0.1 }))};
    --face-gradient-start-active: rgba(${baseColor.red}, ${baseColor.green}, ${baseColor.blue}, 0.4);
    --face-gradient-start-inactive: rgba(${baseColor.red}, ${baseColor.green}, ${baseColor.blue}, 0.2);
    --face-gradient-end: rgba(${baseColor.red}, ${baseColor.green}, ${baseColor.blue}, 0);
  }`;

  if (!aTheme || !aTheme.colors) {
    gBrowserThemeDefinition.textContent = defaultColors;
    return;
  }
  const extraColors = [];
  let bgAlpha = 1;
  if (aTheme.images) {
    if (aTheme.images.headerURL)
      extraColors.push(`--browser-header-url: url(${JSON.stringify(aTheme.images.headerURL)})`);
    if (Array.isArray(aTheme.images.additional_backgrounds) &&
        aTheme.images.additional_backgrounds.length > 0) {
      extraColors.push(`--browser-bg-url: url(${JSON.stringify(aTheme.images.additional_backgrounds[0])})`);
      bgAlpha = 0.75;
    }
  }
  const themeBaseColor = Color.mixCSSColors(aTheme.colors.accentcolor, 'rgba(0, 0, 0, 0)', bgAlpha);
  let toolbarColor = Color.mixCSSColors(themeBaseColor, 'rgba(255, 255, 255, 0.4)', bgAlpha);
  if (aTheme.colors.toolbar)
    toolbarColor = Color.mixCSSColors(themeBaseColor, aTheme.colors.toolbar);
  if (aTheme.colors.tab_line)
    extraColors.push(`--browser-tab-active-marker: ${aTheme.colors.tab_line}`);
  if (aTheme.colors.tab_loading)
    extraColors.push(`--browser-loading-indicator: ${aTheme.colors.tab_loading}`);
  gBrowserThemeDefinition.textContent = `
    ${defaultColors}
    :root {
      --browser-bg-base:         ${themeBaseColor};
      --browser-bg-less-lighter: ${Color.mixCSSColors(themeBaseColor, 'rgba(255, 255, 255, 0.25)', bgAlpha)};
      --browser-bg-lighter:      ${toolbarColor};
      --browser-bg-more-lighter: ${Color.mixCSSColors(toolbarColor, 'rgba(255, 255, 255, 0.6)', bgAlpha)};
      --browser-bg-lightest:     ${Color.mixCSSColors(toolbarColor, 'rgba(255, 255, 255, 0.85)', bgAlpha)};
      --browser-bg-less-darker:  ${Color.mixCSSColors(themeBaseColor, 'rgba(0, 0, 0, 0.1)', bgAlpha)};
      --browser-bg-darker:       ${Color.mixCSSColors(themeBaseColor, 'rgba(0, 0, 0, 0.25)', bgAlpha)};
      --browser-bg-more-darker:  ${Color.mixCSSColors(themeBaseColor, 'rgba(0, 0, 0, 0.5)', bgAlpha)};
      --browser-fg:              ${aTheme.colors.textcolor};
      --browser-fg-active:       ${aTheme.colors.toolbar_text || aTheme.colors.textcolor};
      --browser-border:          ${Color.mixCSSColors(aTheme.colors.textcolor, 'rgba(0, 0, 0, 0)', 0.4)};
      ${extraColors.join(';\n')}
    }
  `;
}

function updateContextualIdentitiesStyle() {
  const definitions = [];
  ContextualIdentities.forEach(aIdentity => {
    if (!aIdentity.colorCode)
      return;
    definitions.push(`
      .tab.contextual-identity-${aIdentity.cookieStoreId} .contextual-identity-marker {
        background-color: ${aIdentity.colorCode};
      }
    `);
  });
  gContextualIdentitiesStyle.textContent = definitions.join('\n');
}

function updateContextualIdentitiesSelector() {
  const anchors = Array.slice(document.querySelectorAll(`.${Constants.kCONTEXTUAL_IDENTITY_SELECTOR}-marker`));
  for (const anchor of anchors) {
    if (ContextualIdentities.getCount() == 0)
      anchor.setAttribute('disabled', true);
    else
      anchor.removeAttribute('disabled');
  }

  const selector = document.getElementById(Constants.kCONTEXTUAL_IDENTITY_SELECTOR);
  const range    = document.createRange();
  range.selectNodeContents(selector);
  range.deleteContents();

  const fragment = document.createDocumentFragment();
  ContextualIdentities.forEach(aIdentity => {
    const item     = document.createElement('li');
    item.dataset.value = aIdentity.cookieStoreId;
    item.textContent = aIdentity.name;
    const icon = document.createElement('span');
    icon.classList.add('icon');
    if (aIdentity.iconUrl) {
      icon.style.backgroundColor = aIdentity.colorCode || 'var(--tab-text)';
      icon.style.mask = `url(${JSON.stringify(aIdentity.iconUrl)}) no-repeat center / 100%`;
    }
    item.insertBefore(icon, item.firstChild);
    fragment.appendChild(item);
  });
  if (configs.inheritContextualIdentityToNewChildTab) {
    const defaultCotnainerItem = document.createElement('li');
    defaultCotnainerItem.dataset.value = 'firefox-default';
    defaultCotnainerItem.textContent = browser.i18n.getMessage('tabbar_newTabWithContexualIdentity_default');
    const icon = document.createElement('span');
    icon.classList.add('icon');
    defaultCotnainerItem.insertBefore(icon, defaultCotnainerItem.firstChild);
    fragment.appendChild(defaultCotnainerItem);
  }
  range.insertNode(fragment);
  range.detach();
}

export async function rebuildAll(aCache) {
  const apiTabs = await browser.tabs.query({ currentWindow: true });
  TabsContainer.clearAll();

  if (aCache) {
    const restored = await SidebarCache.restoreTabsFromCache(aCache, { tabs: apiTabs });
    if (restored) {
      MetricsData.add('rebuildAll (from cache)');
      return true;
    }
  }

  const container = TabsContainer.buildFor(gTargetWindow);
  for (const apiTab of apiTabs) {
    TabIdFixer.fixTab(apiTab);
    const newTab = Tabs.buildTab(apiTab, { existing: true, inRemote: true });
    container.appendChild(newTab);
    TabsUpdate.updateTab(newTab, apiTab, { forceApply: true });
  }
  Tabs.allTabsContainer.appendChild(container);
  MetricsData.add('rebuildAll (from scratch)');
  return false;
}

async function inheritTreeStructure() {
  const response = await browser.runtime.sendMessage({
    type:     Constants.kCOMMAND_PULL_TREE_STRUCTURE,
    windowId: gTargetWindow
  });
  MetricsData.add('inheritTreeStructure: Constants.kCOMMAND_PULL_TREE_STRUCTURE');
  if (response.structure) {
    await Tree.applyTreeStructureToTabs(Tabs.getAllTabs(gTargetWindow), response.structure);
    MetricsData.add('inheritTreeStructure: Tree.applyTreeStructureToTabs');
  }
}

async function waitUntilBackgroundIsReady() {
  try {
    const response = await browser.runtime.sendMessage({
      type: Constants.kCOMMAND_PING_TO_BACKGROUND
    });
    if (response)
      return;
  }
  catch(_e) {
  }
  return new Promise((aResolve, _aReject) => {
    const onBackgroundIsReady = (aMessage, _aSender, _aRespond) => {
      if (!aMessage ||
          !aMessage.type ||
          aMessage.type != Constants.kCOMMAND_PING_TO_SIDEBAR)
        return;
      browser.runtime.onMessage.removeListener(onBackgroundIsReady);
      aResolve();
    };
    browser.runtime.onMessage.addListener(onBackgroundIsReady);
  });
}


export async function confirmToCloseTabs(aCount, _aOptions = {}) {
  if (aCount <= 1 ||
      !configs.warnOnCloseTabs)
    return true;
  const confirm = new RichConfirm({
    message: browser.i18n.getMessage('warnOnCloseTabs_message', [aCount]),
    buttons: [
      browser.i18n.getMessage('warnOnCloseTabs_close'),
      browser.i18n.getMessage('warnOnCloseTabs_cancel')
    ],
    checkMessage: browser.i18n.getMessage('warnOnCloseTabs_warnAgain'),
    checked: true
  });
  const result = await confirm.show();
  switch (result.buttonIndex) {
    case 0:
      if (!result.checked)
        configs.warnOnCloseTabs = false;
      configs.lastConfirmedToCloseTabs = Date.now();
      return true;
    default:
      return false;
  }
}
Commands.onTabsClosing.addListener(confirmToCloseTabs);
TabContextMenu.onTabsClosing.addListener(confirmToCloseTabs);


export function reserveToUpdateTabbarLayout(aOptions = {}) {
  //log('reserveToUpdateTabbarLayout');
  if (reserveToUpdateTabbarLayout.waiting)
    clearTimeout(reserveToUpdateTabbarLayout.waiting);
  if (aOptions.reason && !(reserveToUpdateTabbarLayout.reasons & aOptions.reason))
    reserveToUpdateTabbarLayout.reasons |= aOptions.reason;
  const timeout = aOptions.timeout || 10;
  reserveToUpdateTabbarLayout.timeout = Math.max(timeout, reserveToUpdateTabbarLayout.timeout);
  reserveToUpdateTabbarLayout.waiting = setTimeout(() => {
    delete reserveToUpdateTabbarLayout.waiting;
    const reasons = reserveToUpdateTabbarLayout.reasons;
    reserveToUpdateTabbarLayout.reasons = 0;
    reserveToUpdateTabbarLayout.timeout = 0;
    updateTabbarLayout({ reasons });
  }, reserveToUpdateTabbarLayout.timeout);
}
reserveToUpdateTabbarLayout.reasons = 0;
reserveToUpdateTabbarLayout.timeout = 0;

function updateTabbarLayout(aParams = {}) {
  if (RestoringTabCount.hasMultipleRestoringTabs()) {
    log('updateTabbarLayout: skip until completely restored');
    reserveToUpdateTabbarLayout({
      reason:  aParams.reasons,
      timeout: Math.max(100, aParams.timeout)
    });
    return;
  }
  //log('updateTabbarLayout');
  const range = document.createRange();
  range.selectNodeContents(gTabBar);
  const containerHeight = gTabBar.getBoundingClientRect().height;
  const contentHeight   = range.getBoundingClientRect().height;
  //log('height: ', { container: containerHeight, content: contentHeight });
  const overflow = containerHeight < contentHeight;
  if (overflow && !gTabBar.classList.contains(Constants.kTABBAR_STATE_OVERFLOW)) {
    //log('overflow');
    gTabBar.classList.add(Constants.kTABBAR_STATE_OVERFLOW);
    const range = document.createRange();
    range.selectNode(gAfterTabsForOverflowTabBar.querySelector('.newtab-button-box'));
    const offset = range.getBoundingClientRect().height;
    range.detach();
    gTabBar.style.bottom = `${offset}px`;
    nextFrame().then(() => {
      // Tab at the end of the tab bar can be hidden completely or
      // partially (newly opened in small tab bar, or scrolled out when
      // the window is shrunken), so we need to scroll to it explicitely.
      const current = Tabs.getCurrentTab();
      if (!Scroll.isTabInViewport(current)) {
        log('scroll to current tab on updateTabbarLayout');
        Scroll.scrollToTab(current);
        return;
      }
      const lastOpenedTab = Tabs.getLastOpenedTab();
      const reasons       = aParams.reasons || 0;
      if (reasons & Constants.kTABBAR_UPDATE_REASON_TAB_OPEN &&
          !Scroll.isTabInViewport(lastOpenedTab)) {
        log('scroll to last opened tab on updateTabbarLayout ', reasons);
        Scroll.scrollToTab(lastOpenedTab, {
          anchor:            current,
          notifyOnOutOfView: true
        });
      }
    });
  }
  else if (!overflow && gTabBar.classList.contains(Constants.kTABBAR_STATE_OVERFLOW)) {
    //log('underflow');
    gTabBar.classList.remove(Constants.kTABBAR_STATE_OVERFLOW);
    gTabBar.style.bottom = '';
  }

  if (aParams.justNow)
    PinnedTabs.reposition(aParams);
  else
    PinnedTabs.reserveToReposition(aParams);
}


function onFocus(_aEvent) {
  browser.runtime.sendMessage({
    type:     Constants.kNOTIFY_SIDEBAR_FOCUS,
    windowId: gTargetWindow
  });
}

function onBlur(_aEvent) {
  browser.runtime.sendMessage({
    type:     Constants.kNOTIFY_SIDEBAR_BLUR,
    windowId: gTargetWindow
  });
}

function onResize(_aEvent) {
  reserveToUpdateTabbarLayout({
    reason: Constants.kTABBAR_UPDATE_REASON_RESIZE
  });
}

function onTransisionEnd(aEvent) {
  if (aEvent.pseudoElement || // ignore size change of pseudo elements because they won't change height of tabbar contents
      !aEvent.target.classList.contains('tab') || // ignore animations of twisty or something inside tabs
      /opacity|color|text-shadow/.test(aEvent.propertyName))
    return;
  //log('transitionend ', aEvent);
  reserveToUpdateTabbarLayout({
    reason: Constants.kTABBAR_UPDATE_REASON_ANIMATION_END
  });
}

function onBrowserThemeChanged(aUpdateInfo) {
  if (!aUpdateInfo.windowId || // reset to default
      aUpdateInfo.windowId == gTargetWindow)
    applyBrowserTheme(aUpdateInfo.theme);
}


Tabs.onCreated.addListener(_aTab => {
  reserveToUpdateTabbarLayout({
    reason:  Constants.kTABBAR_UPDATE_REASON_TAB_OPEN,
    timeout: configs.collapseDuration
  });
});

Tabs.onRemoving.addListener((aTab, aCloseInfo) => {
  const closeParentBehavior = Tree.getCloseParentBehaviorForTabWithSidebarOpenState(aTab, aCloseInfo);
  if (closeParentBehavior != Constants.kCLOSE_PARENT_BEHAVIOR_CLOSE_ALL_CHILDREN &&
      Tabs.isSubtreeCollapsed(aTab))
    Tree.collapseExpandSubtree(aTab, {
      collapsed: false
    });

  // We don't need to update children because they are controlled by bacgkround.
  // However we still need to update the parent itself.
  Tree.detachTab(aTab, {
    dontUpdateIndent: true
  });

  reserveToUpdateTabbarLayout({
    reason:  Constants.kTABBAR_UPDATE_REASON_TAB_CLOSE,
    timeout: configs.collapseDuration
  });
});

Tabs.onMoved.addListener(_aTab => {
  reserveToUpdateTabbarLayout({
    reason:  Constants.kTABBAR_UPDATE_REASON_TAB_MOVE,
    timeout: configs.collapseDuration
  });
});

Tabs.onDetached.addListener(aTab => {
  if (!Tabs.ensureLivingTab(aTab))
    return;
  // We don't need to update children because they are controlled by bacgkround.
  // However we still need to update the parent itself.
  Tree.detachTab(aTab, {
    dontUpdateIndent: true
  });
});

Tabs.onRestoring.addListener(aTab => {
  if (!configs.useCachedTree) // we cannot know when we should unblock on no cache case...
    return;

  const container = aTab.parentNode;
  // When we are restoring two or more tabs.
  // (But we don't need do this again for third, fourth, and later tabs.)
  if (container.restoredCount == 2)
    UserOperationBlocker.block({ throbber: true });
});

// Tree restoration for "Restore Previous Session"
Tabs.onWindowRestoring.addListener(async aWindowId => {
  if (!configs.useCachedTree)
    return;

  log('Tabs.onWindowRestoring');
  const container = Tabs.getTabsContainer(aWindowId);
  const restoredCount = await container.allTabsRestored;
  if (restoredCount == 1) {
    log('Tabs.onWindowRestoring: single tab restored');
    UserOperationBlocker.unblock({ throbber: true });
    return;
  }

  log('Tabs.onWindowRestoring: continue');
  const cache = await SidebarCache.getEffectiveWindowCache({
    ignorePinnedTabs: true
  });
  if (!cache ||
      (cache.offset &&
       container.childNodes.length <= cache.offset)) {
    log('Tabs.onWindowRestoring: no effective cache');
    await inheritTreeStructure(); // fallback to classic method
    UserOperationBlocker.unblock({ throbber: true });
    return;
  }

  log('Tabs.onWindowRestoring restore! ', cache);
  MetricsData.add('Tabs.onWindowRestoring restore start');
  cache.tabbar.tabsDirty = true;
  const apiTabs = await browser.tabs.query({ windowId: aWindowId });
  const restored = await SidebarCache.restoreTabsFromCache(cache.tabbar, {
    offset: cache.offset || 0,
    tabs:   apiTabs
  });
  if (!restored) {
    await rebuildAll();
    await inheritTreeStructure();
  }
  Indent.updateRestoredTree(restored && cache.offset == 0 ? cache.indent : null);
  updateTabbarLayout({ justNow: true });
  UserOperationBlocker.unblock({ throbber: true });
  MetricsData.add('Tabs.onWindowRestoring restore end');
});


ContextualIdentities.onUpdated.addListener(() => {
  updateContextualIdentitiesStyle();
  updateContextualIdentitiesSelector();
});


function onConfigChange(aChangedKey) {
  const rootClasses = document.documentElement.classList;
  switch (aChangedKey) {
    case 'debug': {
      for (const tab of Tabs.getAllTabs()) {
        TabsUpdate.updateTab(tab, tab.apiTab, { forceApply: true });
      }
      if (configs.debug)
        rootClasses.add('debug');
      else
        rootClasses.remove('debug');
    }; break;

    case 'animation':
      if (configs.animation)
        rootClasses.add('animation');
      else
        rootClasses.remove('animation');
      break;

    case 'sidebarPosition':
      if (configs.sidebarPosition == Constants.kTABBAR_POSITION_RIGHT) {
        rootClasses.add('right');
        rootClasses.remove('left');
      }
      else {
        rootClasses.add('left');
        rootClasses.remove('right');
      }
      Indent.update({ force: true });
      break;

    case 'sidebarDirection':
      if (configs.sidebarDirection == Constants.kTABBAR_DIRECTION_RTL) {
        rootClasses.add('rtl');
        rootClasses.remove('ltr');
      }
      else {
        rootClasses.add('ltr');
        rootClasses.remove('rtl');
      }
      break;

    case 'sidebarScrollbarPosition': {
      let position = configs.sidebarScrollbarPosition;
      if (position == Constants.kTABBAR_SCROLLBAR_POSITION_AUTO)
        position = configs.sidebarPosition;
      if (position == Constants.kTABBAR_SCROLLBAR_POSITION_RIGHT) {
        rootClasses.add('right-scrollbar');
        rootClasses.remove('left-scrollbar');
      }
      else {
        rootClasses.add('left-scrollbar');
        rootClasses.remove('right-scrollbar');
      }
      Indent.update({ force: true });
    }; break;

    case 'baseIndent':
    case 'minIndent':
    case 'maxTreeLevel':
    case 'indentAutoShrink':
    case 'indentAutoShrinkOnlyForVisible':
      Indent.update({ force: true });
      break;

    case 'style':
      location.reload();
      break;

    case 'scrollbarMode':
      rootClasses.remove(Constants.kTABBAR_STATE_NARROW_SCROLLBAR);
      rootClasses.remove(Constants.kTABBAR_STATE_NO_SCROLLBAR);
      rootClasses.remove(Constants.kTABBAR_STATE_OVERLAY_SCROLLBAR);
      switch (configs.scrollbarMode) {
        default:
        case Constants.kTABBAR_SCROLLBAR_MODE_DEFAULT:
          break;
        case Constants.kTABBAR_SCROLLBAR_MODE_NARROW:
          rootClasses.add(Constants.kTABBAR_STATE_NARROW_SCROLLBAR);
          break;
        case Constants.kTABBAR_SCROLLBAR_MODE_HIDE:
          rootClasses.add(Constants.kTABBAR_STATE_NO_SCROLLBAR);
          break;
        case Constants.kTABBAR_SCROLLBAR_MODE_OVERLAY:
          rootClasses.add(Constants.kTABBAR_STATE_OVERLAY_SCROLLBAR);
          break;
      }
      break;

    case 'colorScheme':
      document.documentElement.setAttribute('color-scheme', configs.colorScheme);
      break;

    case 'narrowScrollbarSize':
      location.reload();
      break;

    case 'userStyleRules':
      applyUserStyleRules()
      break;

    case 'inheritContextualIdentityToNewChildTab':
      updateContextualIdentitiesSelector();
      break;

    case 'showContextualIdentitiesSelector':
      if (configs[aChangedKey])
        rootClasses.add(Constants.kTABBAR_STATE_CONTEXTUAL_IDENTITY_SELECTABLE);
      else
        rootClasses.remove(Constants.kTABBAR_STATE_CONTEXTUAL_IDENTITY_SELECTABLE);
      break;

    case 'showNewTabActionSelector':
      if (configs[aChangedKey])
        rootClasses.add(Constants.kTABBAR_STATE_NEWTAB_ACTION_SELECTABLE);
      else
        rootClasses.remove(Constants.kTABBAR_STATE_NEWTAB_ACTION_SELECTABLE);
      break;

    case 'simulateSVGContextFill':
      if (configs[aChangedKey])
        rootClasses.add('simulate-svg-context-fill');
      else
        rootClasses.remove('simulate-svg-context-fill');
      break;
  }
}


const gTreeChangesFromRemote = new Set();
function waitUntilAllTreeChangesFromRemoteAreComplete() {
  return Promise.all(Array.from(gTreeChangesFromRemote.values()));
}

function onMessage(aMessage, _aSender, _aRespond) {
  if (!aMessage ||
      typeof aMessage.type != 'string' ||
      aMessage.type.indexOf('treestyletab:') != 0)
    return;

  //log('onMessage: ', aMessage, aSender);
  switch (aMessage.type) {
    case Constants.kCOMMAND_PING_TO_SIDEBAR: {
      if (aMessage.windowId == gTargetWindow)
        return Promise.resolve(true);
    }; break;

    case Constants.kCOMMAND_PUSH_TREE_STRUCTURE:
      if (aMessage.windowId == gTargetWindow)
        Tree.applyTreeStructureToTabs(Tabs.getAllTabs(gTargetWindow), aMessage.structure);
      break;

    case Constants.kCOMMAND_NOTIFY_TAB_RESTORING:
      RestoringTabCount.increment();
      break;

    case Constants.kCOMMAND_NOTIFY_TAB_RESTORED:
      RestoringTabCount.decrement();
      break;

    case Constants.kCOMMAND_NOTIFY_TAB_FAVICON_UPDATED:
      Tabs.onFaviconUpdated.dispatch(Tabs.getTabById(aMessage.tab), aMessage.favIconUrl);
      break;

    case Constants.kCOMMAND_CHANGE_SUBTREE_COLLAPSED_STATE: {
      if (aMessage.windowId == gTargetWindow) return (async () => {
        await Tabs.waitUntilTabsAreCreated(aMessage.tab);
        const tab = Tabs.getTabById(aMessage.tab);
        if (!tab)
          return;
        const params = {
          collapsed: aMessage.collapsed,
          justNow:   aMessage.justNow,
          stack:     aMessage.stack
        };
        if (aMessage.manualOperation)
          Tree.manualCollapseExpandSubtree(tab, params);
        else
          Tree.collapseExpandSubtree(tab, params);
      })();
    }; break;

    case Constants.kCOMMAND_CHANGE_TAB_COLLAPSED_STATE: {
      if (aMessage.windowId == gTargetWindow) return (async () => {
        await Tabs.waitUntilTabsAreCreated(aMessage.tab);
        const tab = Tabs.getTabById(aMessage.tab);
        if (!tab)
          return;
        // Tree's collapsed state can be changed before this message is delivered,
        // so we should ignore obsolete messages.
        if (aMessage.byAncestor &&
            aMessage.collapsed != Tabs.getAncestorTabs(tab).some(Tabs.isSubtreeCollapsed))
          return;
        const params = {
          collapsed:   aMessage.collapsed,
          justNow:     aMessage.justNow,
          broadcasted: true,
          stack:       aMessage.stack
        };
        Tree.collapseExpandTab(tab, params);
      })();
    }; break;

    case Constants.kCOMMAND_MOVE_TABS_BEFORE:
      return (async () => {
        await Tabs.waitUntilTabsAreCreated(aMessage.tabs.concat([aMessage.nextTab]));
        return TabsMove.moveTabsBefore(
          aMessage.tabs.map(Tabs.getTabById),
          Tabs.getTabById(aMessage.nextTab),
          aMessage
        ).then(aTabs => aTabs.map(aTab => aTab.id));
      })();

    case Constants.kCOMMAND_MOVE_TABS_AFTER:
      return (async () => {
        await Tabs.waitUntilTabsAreCreated(aMessage.tabs.concat([aMessage.previousTab]));
        return TabsMove.moveTabsAfter(
          aMessage.tabs.map(Tabs.getTabById),
          Tabs.getTabById(aMessage.previousTab),
          aMessage
        ).then(aTabs => aTabs.map(aTab => aTab.id));
      })();

    case Constants.kCOMMAND_REMOVE_TABS_INTERNALLY:
      return (async () => {
        await Tabs.waitUntilTabsAreCreated(aMessage.tabs);
        return TabsInternalOperation.removeTabs(aMessage.tabs.map(Tabs.getTabById), aMessage.options);
      })();

    case Constants.kCOMMAND_ATTACH_TAB_TO: {
      if (aMessage.windowId == gTargetWindow) {
        const promisedComplete = (async () => {
          await Promise.all([
            Tabs.waitUntilTabsAreCreated([
              aMessage.child,
              aMessage.parent,
              aMessage.insertBefore,
              aMessage.insertAfter
            ]),
            waitUntilAllTreeChangesFromRemoteAreComplete()
          ]);
          log('attach tab from remote ', aMessage);
          const child  = Tabs.getTabById(aMessage.child);
          const parent = Tabs.getTabById(aMessage.parent);
          if (child && parent)
            await Tree.attachTabTo(child, parent, Object.assign({}, aMessage, {
              insertBefore: Tabs.getTabById(aMessage.insertBefore),
              insertAfter:  Tabs.getTabById(aMessage.insertAfter),
              inRemote:     false,
              broadcast:    false
            }));
          gTreeChangesFromRemote.delete(promisedComplete);
        })();
        gTreeChangesFromRemote.add(promisedComplete);
        return promisedComplete;
      }
    }; break;

    case Constants.kCOMMAND_DETACH_TAB: {
      if (aMessage.windowId == gTargetWindow) {
        const promisedComplete = (async () => {
          await Promise.all([
            Tabs.waitUntilTabsAreCreated(aMessage.tab),
            waitUntilAllTreeChangesFromRemoteAreComplete()
          ]);
          const tab = Tabs.getTabById(aMessage.tab);
          if (tab)
            Tree.detachTab(tab, aMessage);
          gTreeChangesFromRemote.delete(promisedComplete);
        })();
        gTreeChangesFromRemote.add(promisedComplete);
        return promisedComplete;
      }
    }; break;

    case Constants.kCOMMAND_BLOCK_USER_OPERATIONS: {
      if (aMessage.windowId == gTargetWindow)
        UserOperationBlocker.blockIn(gTargetWindow, aMessage);
    }; break;

    case Constants.kCOMMAND_UNBLOCK_USER_OPERATIONS: {
      if (aMessage.windowId == gTargetWindow)
        UserOperationBlocker.unblockIn(gTargetWindow, aMessage);
    }; break;

    case Constants.kCOMMAND_BROADCAST_TAB_STATE: {
      if (!aMessage.tabs.length)
        break;
      return (async () => {
        await Tabs.waitUntilTabsAreCreated(aMessage.tabs);
        const add    = aMessage.add || [];
        const remove = aMessage.remove || [];
        log('apply broadcasted tab state ', aMessage.tabs, {
          add:    add.join(','),
          remove: remove.join(',')
        });
        const modified = add.concat(remove);
        for (let tab of aMessage.tabs) {
          tab = Tabs.getTabById(tab);
          if (!tab)
            continue;
          add.forEach(aState => tab.classList.add(aState));
          remove.forEach(aState => tab.classList.remove(aState));
          if (modified.includes(Constants.kTAB_STATE_AUDIBLE) ||
            modified.includes(Constants.kTAB_STATE_SOUND_PLAYING) ||
            modified.includes(Constants.kTAB_STATE_MUTED)) {
            SidebarTabs.updateSoundButtonTooltip(tab);
            if (aMessage.bubbles)
              TabsUpdate.updateParentTab(Tabs.getParentTab(tab));
          }
        }
      })();
    }; break;

    case Constants.kCOMMAND_CONFIRM_TO_CLOSE_TABS: {
      if (aMessage.windowId == gTargetWindow)
        return confirmToCloseTabs(aMessage.count);
    }; break;
  }
}
