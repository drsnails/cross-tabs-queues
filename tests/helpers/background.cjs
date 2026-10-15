const assert = require('node:assert/strict');
const fs = require('node:fs');
const vm = require('node:vm');

function createBackground(queueItems, options = {}) {
    let localValues = options.migrate ? {} : { yt_queue_list: structuredClone(queueItems) };
    let handleMessage;
    let storageWrites = 0;
    const injectedTabs = [];
    const openedTabs = [];
    const tabMessages = [];
    const scriptCalls = [];
    let onTabUpdated;
    const tabs = options.tabs || [];
    const storageListeners = [];
    const sessionValues = options.sessionValues || {};
    const pageContext = vm.createContext({ URL,
        location: { href: tabs[0]?.url },
        document: options.diagnosticPage || options.youtubePage || { querySelectorAll: () => [], getElementById: () => null },
    });
    const context = {
        URL,
        crypto: require('node:crypto').webcrypto,
        setTimeout,
        chrome: {
            scripting: {
                async executeScript(optionsForScript) {
                    scriptCalls.push(optionsForScript);
                    if (options.scriptError) throw new Error(options.scriptError);
                    if (optionsForScript.files) {
                        for (const file of optionsForScript.files) vm.runInContext(fs.readFileSync(`${__dirname}/../../${file}`, 'utf8'), pageContext);
                        return [{}];
                    }
                    if (options.nativeScriptError && optionsForScript.world === 'MAIN') throw new Error(options.nativeScriptError);
                    const result = vm.runInContext(`(${optionsForScript.func.toString()})()`, pageContext);
                    return [{ result: JSON.parse(JSON.stringify(result)) }];
                },
            },
            storage: {
                onChanged: { addListener(listener) { storageListeners.push(listener); } },
                session: {
                    async get(key) { return { [key]: structuredClone(sessionValues[key]) }; },
                    async set(values) { Object.assign(sessionValues, structuredClone(values)); },
                },
                local: {
                    async get(key) { return { [key]: structuredClone(localValues[key]) }; },
                    async set(values) {
                        storageWrites++;
                        Object.assign(localValues, structuredClone(values));
                        const changes = Object.fromEntries(Object.entries(values).map(([key, value]) => [key, { newValue: structuredClone(value) }]));
                        storageListeners.forEach(listener => listener(changes, 'local'));
                    },
                },
                sync: { async get() { return { yt_queue_list: structuredClone(queueItems) }; } },
            },
            tabs: {
                onUpdated: { addListener(listener) { onTabUpdated = listener; } },
                async query(filter) {
                    if (filter.active) return tabs.slice(0, 1);
                    return filter.url ? tabs.filter(tab => /^https?:\/\/([^/]+\.)?youtube\.com\/watch/.test(tab.url || '')) : tabs;
                },
                async sendMessage(tabId, message) {
                    injectedTabs.push(tabId);
                    tabMessages.push({ tabId, ...message });
                    if (message.type === 'PING') return { pong: true };
                    if (message.type === 'QUEUE_UPDATED') return { success: true };
                    throw new Error('Metadata not ready');
                },
                async update(tabId, values) { openedTabs.push({ tabId, ...values }); },
                async create(values) { openedTabs.push(values); },
            },
            runtime: {
                getManifest: () => ({ name: 'YouTube Custom Queue', version: '1.0.0' }),
                onInstalled: { addListener() {} },
                onMessage: { addListener(listener) { handleMessage = listener; } },
            },
            contextMenus: { onClicked: { addListener() {} } },
        },
    };
    vm.createContext(context);
    context.importScripts = file => vm.runInContext(fs.readFileSync(`${__dirname}/../../${file}`, 'utf8'), context);
    vm.runInContext(fs.readFileSync(`${__dirname}/../../background.js`, 'utf8'), context);
    return {
        chrome: {
            storage: context.chrome.storage,
            runtime: {
                sendMessage(message) {
                    return new Promise(resolve => handleMessage(message, {}, resolve));
                },
            },
        },
        request(type, payload) {
            return new Promise(resolve => {
                assert.equal(handleMessage({ type, payload }, {}, response => {
                    resolve(JSON.parse(JSON.stringify(response)));
                }), true);
            });
        },
        get queue() { return localValues.yt_queue_list; },
        get playlists() { return localValues.saved_playlists; },
        get storageWrites() { return storageWrites; },
        injectedTabs,
        openedTabs,
        tabMessages,
        scriptCalls,
        updateTab(tabId, changes, tab) { onTabUpdated(tabId, changes, tab); },
    };
}

module.exports = { createBackground };
