// ==UserScript==
// @name         Poe Effort & Points Monitor
// @namespace    https://poe.com/
// @version      1.2.1
// @description  在 Poe 中固定阅读位置、保守地管理 Effort，并显示积分百分比与最近一轮的官方费用。
// @author       xiadengma (积分逻辑来源) + OpenAI
// @match        https://poe.com/*
// @match        https://www.poe.com/*
// @run-at       document-start
// @grant        GM_xmlhttpRequest
// @grant        GM.xmlHttpRequest
// @grant        GM_getValue
// @grant        GM_setValue
// @grant        GM.getValue
// @grant        GM.setValue
// @connect      poe.com
// @connect      www.poe.com
// ==/UserScript==

/*
 * 积分显示的思路参考 xiadengma 的 Poe 积分显示脚本（v1.4）：
 * https://gist.githubusercontent.com/XIADENGMA/62e1239fdbd9c9b7ca0da285c2756fd1/raw/Poe_show_points_usage.user.js
 * 保留作者署名与来源；本脚本不声明原作者参与整合，也不设置自动更新地址。
 */
(function (root, factory) {
    'use strict';
    const api = factory();
    if (typeof module !== 'undefined' && module.exports) {
        module.exports = api;
    } else if (root) {
        api.start(root);
    }
})(typeof window !== 'undefined' ? window : globalThis, function () {
    'use strict';

    const INSTANCE_KEY = '__poeEffortPointsMonitorV1__';
    const SETTINGS_KEY = 'poe-effort-points-settings-v1';
    const MANUAL_CONTEXT_KEY = 'poe-effort-points-manual-context-v1';
    const DEFAULT_SETTINGS = Object.freeze({
        autoLow: true,
        sendGuard: true,
        strictGuard: false,
        readingLock: true,
        debug: false
    });
    const LEVELS = Object.freeze(['low', 'medium', 'high', 'xhigh', 'max', 'none']);

    function normalizeText(value) {
        return String(value || '').replace(/\s+/g, ' ').trim();
    }

    function parseEffortLevel(value) {
        const text = normalizeText(value).toLowerCase();
        const matches = [];
        const patterns = [
            ['low', /\blow\b|低(?:强度)?/g],
            ['medium', /\bmedium\b|\bmed\b|中(?:等)?(?:强度)?/g],
            ['xhigh', /\bxhigh\b/g],
            ['high', /\bhigh\b|高(?:强度)?/g],
            ['max', /\bmax(?:imum)?\b|最高(?:强度)?/g],
            ['none', /\bnone\b|无(?:推理|强度)?/g]
        ];
        for (const [level, pattern] of patterns) {
            if (pattern.test(text)) matches.push(level);
            pattern.lastIndex = 0;
        }
        return matches.length === 1 ? matches[0] : null;
    }

    function isEffortSelectOptions(options) {
        if (!Array.isArray(options) || options.length < 2) return false;
        // The Effort label and surrounding group establish that this is the
        // right control. Require one unambiguous Low option, but allow Poe to
        // add levels this script does not know yet (for example Adaptive).
        // Unknown choices are never substituted for Low.
        const lowOptions = options.filter(option =>
            normalizeText(option && option.value).toLowerCase() === 'low' &&
            parseEffortLevel(option && option.text) === 'low'
        );
        return lowOptions.length === 1;
    }

    function isExplicitlyUnavailableEffort(name, disabled) {
        if (!disabled) return false;
        const text = normalizeText(name);
        return /(?:\beffort\b.{0,30}\b(?:unavailable|not\s+supported)\b|\b(?:unavailable|not\s+supported)\b.{0,30}\beffort\b|(?:effort|推理强度).{0,20}(?:不可用|不支持)|(?:不可用|不支持).{0,20}(?:effort|推理强度))/i.test(text);
    }

    function parsePointsBalance(value) {
        const text = String(value || '').replace(/\u00a0/g, ' ');
        const poeAvailable = text.match(/(?:^|\n)\s*积分\s*\n\s*([\d][\d,]*)\s*\n\s*可用(?:\s|$)/m);
        if (poeAvailable) {
            const points = Number(poeAvailable[1].replace(/,/g, ''));
            if (Number.isSafeInteger(points) && points >= 0) return points;
        }
        const patterns = [
            /(?:compute\s*points|(?:remaining|current|available)\s*points?|points?\s*(?:remaining|balance))[\s:：-]{0,12}([\d][\d,]*)/i,
            /(?:剩余|当前|可用|计算)\s*积分[\s:：-]{0,12}([\d][\d,]*)/,
            /([\d][\d,]*)\s*(?:compute\s*points|points?\s*(?:remaining|balance))/i
        ];
        for (const pattern of patterns) {
            const match = text.match(pattern);
            if (!match) continue;
            const points = Number(match[1].replace(/,/g, ''));
            if (Number.isSafeInteger(points) && points >= 0) return points;
        }

        const lines = text.split(/[\r\n]+/).map(normalizeText).filter(Boolean);
        const labelPattern = /compute\s*points|(?:remaining|current|available)\s*points?|points?\s*(?:remaining|balance)|(?:剩余|当前|可用|计算)\s*积分/i;
        for (let index = 0; index < lines.length; index += 1) {
            if (!labelPattern.test(lines[index])) continue;
            labelPattern.lastIndex = 0;
            const sameLine = lines[index].match(/(?:compute\s*points|(?:remaining|current|available)\s*points?|points?\s*(?:remaining|balance)|(?:剩余|当前|可用|计算)\s*积分)[\s:：-]{0,12}([\d][\d,]*)/i);
            const adjacentLine = lines[index + 1] && lines[index + 1].match(/^([\d][\d,]*)(?:\s*(?:points?|积分))?$/i);
            for (const match of [sameLine, adjacentLine]) {
                if (!match) continue;
                const points = Number(match[1].replace(/,/g, ''));
                if (Number.isSafeInteger(points) && points >= 0) return points;
            }
        }
        return null;
    }

    function parseRemainingPercent(value) {
        const text = String(value || '').replace(/\u00a0/g, ' ');
        const patterns = [
            /剩余\s*(\d{1,3})\s*%\s*(?:的)?\s*(?:积分|points?)?/i,
            /\bremaining\s*(?:points?\s*)?[:：]?\s*(\d{1,3})\s*%/i,
            /\b(\d{1,3})\s*%\s*(?:of\s+)?(?:the\s+)?(?:points?\s+)?remaining\b/i
        ];
        for (const pattern of patterns) {
            const match = text.match(pattern);
            if (!match) continue;
            const percent = Number(match[1]);
            if (Number.isInteger(percent) && percent >= 0 && percent <= 100) return percent;
        }
        return null;
    }

    function chatIdFromHref(href, base) {
        try {
            const url = new URL(href, base || 'https://poe.com/');
            const match = url.pathname.match(/^\/chat\/([^/]+)\/?$/);
            return match ? decodeURIComponent(match[1]) : null;
        } catch (_) {
            return null;
        }
    }

    function parseChatPageData(nextData, expectedChatCode) {
        // These are the server-rendered fields observed on Poe's own chat page.
        // Never use sidebar messages, a chat title, or a balance delta as a fee.
        const chat = nextData && nextData.props && nextData.props.pageProps &&
            nextData.props.pageProps.data && nextData.props.pageProps.data.mainQuery &&
            nextData.props.pageProps.data.mainQuery.chatOfCode;
        if (!chat || chat.chatCode !== expectedChatCode || !Number.isSafeInteger(chat.chatId)) {
            throw new Error('聊天资料与当前聊天不匹配');
        }
        const connection = chat.messagesConnection;
        if (!connection || !Array.isArray(connection.edges)) throw new Error('未读到官方消息列表');
        const messages = connection.edges.map(edge => edge && edge.node).filter(Boolean)
            .filter(message => !message.isDeleted && !message.isChatAnnouncement)
            .map(message => ({
                id: Number.isSafeInteger(message.messageId) ? String(message.messageId) : null,
                code: typeof message.messageCode === 'string' && /^[a-zA-Z0-9_-]+$/.test(message.messageCode)
                    ? message.messageCode : null,
                bot: message.authorUser === null && Boolean(message.bot),
                jobId: message.responsibleJob && Number.isSafeInteger(message.responsibleJob.jobId)
                    ? String(message.responsibleJob.jobId) : null,
                state: message.state
            }));
        if (messages.some(message => !message.id || !message.code)) throw new Error('官方消息标识缺失');
        return {
            chatId: chat.chatId,
            chatCode: chat.chatCode,
            messages,
            historyComplete: Boolean(connection.pageInfo && connection.pageInfo.hasPreviousPage === false)
        };
    }

    function parseMessageCostData(nextData, chatId, message) {
        const mainQuery = nextData && nextData.props && nextData.props.pageProps &&
            nextData.props.pageProps.data && nextData.props.pageProps.data.mainQuery;
        const detail = mainQuery && mainQuery.messageOfCode;
        if (!detail || !nextData.query || nextData.query.message !== message.code ||
            String(detail.messageId) !== message.id || !detail.chat || detail.chat.chatId !== chatId) {
            throw new Error('费用资料与当前回复不匹配');
        }
        const job = detail.responsibleJob;
        if (!job) return { status: 'pending', points: null, messageId: message.id };
        if (message.jobId && String(job.jobId) !== message.jobId) throw new Error('计费任务已变化，等待重新核对');
        const created = job.createdMessagesConnection && job.createdMessagesConnection.edges;
        if (!Number.isSafeInteger(job.jobId) || !Array.isArray(created) ||
            !created.some(edge => edge.node && String(edge.node.messageId) === message.id &&
                edge.node.chat && edge.node.chat.chatId === chatId)) {
            throw new Error('无法确认该笔费用属于当前回复');
        }
        const settled = job.state === 'completed' && detail.state === 'complete';
        const validPoints = Number.isSafeInteger(job.totalCostPoints) && job.totalCostPoints >= 0;
        return {
            status: settled && validPoints ? 'settled' : 'pending',
            points: settled && validPoints ? job.totalCostPoints : null,
            messageId: message.id,
            jobId: String(job.jobId),
            code: message.code
        };
    }

    function roundUsageText(usage) {
        if (usage && usage.status === 'settled' && Number.isSafeInteger(usage.points) && usage.points >= 0) {
            return `${usage.points.toLocaleString()} 积分`;
        }
        return ({ idle: '待发送', loading: '读取中', pending: '待结算' })[usage && usage.status] || '未知';
    }

    function createRoundCostReader({ readChat, readMessage, wait, now = Date.now, onUpdate, makeController = () => new AbortController() }) {
        let active = null;
        let generation = 0;
        const cache = new Map();
        function cancel() {
            generation += 1;
            if (active) active.controller.abort();
            active = null;
        }
        function start(chatCode, targetId) {
            const messageId = targetId ? String(targetId).replace(/^message-/, '') : null;
            const key = `${chatCode}:${messageId || 'latest'}`;
            if (active && active.key === key) return active.promise;
            cancel();
            const version = generation;
            const task = { key, controller: makeController(), promise: null };
            const signal = task.controller.signal;
            const current = () => generation === version && !signal.aborted;
            const publish = value => {
                if (current()) onUpdate({ chatCode, points: null, messageId, ...value });
                return value;
            };
            active = task;
            task.promise = (async () => {
                publish({ status: messageId ? 'pending' : 'loading' });
                const startedAt = now();
                const retryAt = [0, 2000, 5000, 10000, 20000];
                let lastState = 'unknown';
                let failureReason = '';
                for (const at of retryAt) {
                    const remainingWait = startedAt + at - now();
                    if (remainingWait > 0) await wait(remainingWait, signal);
                    if (!current() || now() - startedAt >= 30000) break;
                    try {
                        const chat = await readChat(chatCode, { signal, timeout: Math.min(8000, 30000 - (now() - startedAt)), messageId });
                        if (!current()) return null;
                        const latest = chat.messages[chat.messages.length - 1];
                        if (!latest) {
                            return publish({ status: chat.historyComplete && !messageId ? 'idle' : 'unknown' });
                        }
                        // A late server snapshot must not show the previous round's
                        // price while a newly completed reply is being looked up.
                        if (messageId && latest.id !== messageId) {
                            lastState = 'pending';
                            publish({ status: 'pending' });
                            continue;
                        }
                        if (!latest.bot || latest.state !== 'complete') {
                            lastState = 'pending';
                            publish({ status: 'pending', messageId: latest.id });
                            continue;
                        }
                        const cacheKey = `${chatCode}:${latest.id}:${latest.jobId || ''}`;
                        if (cache.has(cacheKey)) return publish(cache.get(cacheKey));
                        const remaining = 30000 - (now() - startedAt);
                        if (remaining <= 0) break;
                        const result = await readMessage(latest, chat.chatId, { signal, timeout: Math.min(8000, remaining) });
                        if (!current()) return null;
                        lastState = result.status;
                        publish(result);
                        if (result.status === 'settled') {
                            if (latest.jobId) cache.set(cacheKey, result);
                            if (cache.size > 100) cache.delete(cache.keys().next().value);
                            return result;
                        }
                    } catch (error) {
                        if (!current()) return null;
                        lastState = 'unknown';
                        const message = error && error.message || '';
                        failureReason = /^(聊天资料|官方消息|未读到|Poe 页面|费用资料|计费任务|无法确认|用户脚本)/.test(message)
                            ? message : '官方页面数据格式无法解析';
                    }
                }
                return current() ? publish({ status: lastState, retryStopped: true, failureReason }) : null;
            })().finally(() => { if (active === task) active = null; });
            return task.promise;
        }
        return Object.freeze({ start, cancel, busy: () => Boolean(active) });
    }

    function mutationContainsMessages(mutation) {
        const target = mutation && mutation.target;
        const element = target && (target.nodeType === 1 ? target : target.parentElement);
        if (element && element.closest && element.closest('[id^="message-"]')) return true;
        return Boolean(mutation && mutation.type === 'childList' && Array.from(mutation.addedNodes || []).some(node =>
            node.nodeType === 1 && (node.matches('[id^="message-"]') || node.querySelector('[id^="message-"]'))));
    }

    function isIgnoredMutation(mutation) {
        const target = mutation && mutation.target;
        const element = target && (target.nodeType === 1 ? target : target.parentElement);
        if (!element || !element.closest) return false;
        if (element.closest('[data-poe-effort-points-ui="root"]') || mutationContainsMessages(mutation)) return true;
        if (mutation.type === 'characterData') {
            return !element.closest('button,[role="button"],[role="combobox"],[aria-haspopup]');
        }
        return false;
    }

    function effortDisplayName(effort) {
        if (!effort || !LEVELS.includes(effort.level)) return 'None';
        if (effort.level === 'xhigh') return 'XHigh';
        return effort.level[0].toUpperCase() + effort.level.slice(1);
    }

    function createFixedCoalescer(schedule, cancel, callback, delayMs) {
        let timer = null;
        let disposed = false;
        return Object.freeze({
            request(immediate) {
                if (disposed || timer !== null) return;
                timer = schedule(() => {
                    timer = null;
                    if (!disposed) callback();
                }, immediate ? 0 : delayMs);
            },
            cancel() {
                if (timer !== null) cancel(timer);
                timer = null;
            },
            dispose() {
                if (timer !== null) cancel(timer);
                timer = null;
                disposed = true;
            }
        });
    }

    function createReadingPositionGuard(win, onState = () => {}) {
        const doc = win.document;
        const messageSelector = '[id^="message-"]';
        const uiSelector = '[data-poe-effort-points-ui="root"]';
        const editorSelector = 'input,textarea,select,[contenteditable]:not([contenteditable="false"]),[role="textbox"],[role="combobox"]';
        let enabled = false;
        let scroller = null;
        let anchor = null;
        let lockedTop = 0;
        let route = '';
        let frame = null;
        let settleTimer = null;
        let settleDeadline = 0;
        let settling = false;
        let restoring = false;
        let correctedTop = null;
        let draggingScrollbar = false;
        let touch = null;
        let observer = null;
        let resizeObserver = null;
        let observedSizes = [];
        let savedStyles = [];
        let lastState = '';
        const listeners = [];

        function publish() {
            const available = Boolean(scroller && scroller.isConnected && scroller.querySelector(messageSelector));
            const status = !enabled ? 'off' : !available ? 'waiting' : settling ? 'settling' : 'locked';
            const key = `${status}:${available}`;
            if (key === lastState) return;
            lastState = key;
            onState({ status, canJump: available });
        }

        function viewport() {
            if (scroller === doc.scrollingElement) {
                return { top: 0, bottom: win.innerHeight, left: 0, right: win.innerWidth };
            }
            const rect = scroller.getBoundingClientRect();
            const top = Math.max(0, rect.top + scroller.clientTop);
            return { top, bottom: Math.min(win.innerHeight, rect.top + scroller.clientTop + scroller.clientHeight),
                left: Math.max(0, rect.left), right: Math.min(win.innerWidth, rect.right) };
        }

        function findScroller() {
            const messages = Array.from(doc.querySelectorAll(messageSelector)).filter(message =>
                message.isConnected && message.getClientRects().length && !message.closest('dialog,[role="dialog"],aside,nav'));
            if (!messages.length) return null;
            const candidates = [];
            for (let parent = messages[messages.length - 1].parentElement; parent; parent = parent.parentElement) {
                if (!parent.contains(messages[0]) || parent.clientHeight <= 0 ||
                    !/^(auto|scroll|overlay)$/.test(win.getComputedStyle(parent).overflowY)) continue;
                const candidate = parent === doc.body || parent === doc.documentElement ? doc.scrollingElement : parent;
                if (candidate && !candidates.includes(candidate)) candidates.push(candidate);
            }
            // overflow-x:hidden also computes overflow-y:auto on message
            // wrappers. Prefer a real scroll range shared by the conversation,
            // rather than accidentally locking just the newest reply's wrapper.
            return candidates.find(element => element.scrollHeight > element.clientHeight + 1 || Math.abs(element.scrollTop) > 1) ||
                candidates[candidates.length - 1] || (doc.scrollingElement && doc.scrollingElement.clientHeight > 0 ? doc.scrollingElement : null);
        }

        function protectStyles() {
            for (const entry of savedStyles) {
                const style = scroller.style;
                if (style.getPropertyValue(entry.name) === entry.applied && style.getPropertyPriority(entry.name) === 'important') continue;
                entry.value = style.getPropertyValue(entry.name);
                entry.priority = style.getPropertyPriority(entry.name);
                entry.owned = true;
                style.setProperty(entry.name, entry.applied, 'important');
            }
        }

        function measureText(node, offset) {
            if (!node || !node.isConnected || node.nodeType !== 3 || offset >= node.length) return null;
            const range = doc.createRange();
            range.setStart(node, offset);
            range.setEnd(node, offset + 1);
            const rect = range.getBoundingClientRect();
            return rect.height > 0 ? rect : null;
        }

        function captureAnchor() {
            const box = viewport();
            if (box.bottom <= box.top) return null;
            const y = box.top + Math.min(32, (box.bottom - box.top) / 4);
            for (const fraction of [0.5, 0.35, 0.65]) {
                const x = box.left + (box.right - box.left) * fraction;
                const hits = doc.elementsFromPoint ? doc.elementsFromPoint(x, y) : [];
                const hit = hits.find(element => scroller.contains(element) && element.closest(messageSelector) &&
                    !element.closest(`button,${editorSelector},${uiSelector}`));
                if (!hit) continue;
                const message = hit.closest(messageSelector);
                const element = hit.closest(`p,li,pre,blockquote,h1,h2,h3,h4,h5,h6,td,th,${messageSelector}`) || message;
                const result = { viewportTop: box.top, element, elementY: element.getBoundingClientRect().top - box.top,
                    message, messageY: message.getBoundingClientRect().top - box.top };
                // Keep only a DOM reference and a character offset, never a copy
                // of the message. A text anchor also survives line wrapping.
                const caret = doc.caretPositionFromPoint ? doc.caretPositionFromPoint(x, y) : null;
                const range = !caret && doc.caretRangeFromPoint ? doc.caretRangeFromPoint(x, y) : null;
                const node = caret ? caret.offsetNode : range && range.startContainer;
                const offset = caret ? caret.offset : range && range.startOffset;
                if (node && message.contains(node)) {
                    const rect = measureText(node, offset);
                    if (rect && rect.bottom > box.top && rect.top < box.bottom) {
                        Object.assign(result, { node, offset, textY: rect.top - box.top });
                    }
                }
                return result;
            }
            const message = Array.from(scroller.querySelectorAll(messageSelector)).find(element => {
                const rect = element.getBoundingClientRect();
                return rect.bottom > box.top && rect.top < box.bottom;
            });
            return message ? { viewportTop: box.top, element: message, elementY: message.getBoundingClientRect().top - box.top } : null;
        }

        function observeSizes() {
            if (!resizeObserver) return;
            const elements = [...new Set([scroller, scroller.firstElementChild, anchor && anchor.element, anchor && anchor.message].filter(Boolean))];
            if (elements.length === observedSizes.length && elements.every((element, index) => element === observedSizes[index])) return;
            resizeObserver.disconnect();
            observedSizes = elements;
            for (const element of elements) resizeObserver.observe(element);
        }

        function capture() {
            lockedTop = scroller.scrollTop;
            anchor = captureAnchor();
            observeSizes();
        }

        function restore() {
            if (!scroller || !scroller.isConnected || settling || restoring || draggingScrollbar) return;
            restoring = true;
            try {
                protectStyles();
                const box = viewport();
                let delta = null;
                if (anchor) {
                    const textRect = measureText(anchor.node, anchor.offset);
                    if (textRect) delta = textRect.top - box.top - anchor.textY;
                    else if (anchor.element.isConnected) delta = anchor.element.getBoundingClientRect().top - box.top - anchor.elementY;
                    else if (anchor.message && anchor.message.isConnected) delta = anchor.message.getBoundingClientRect().top - box.top - anchor.messageY;
                }
                const desired = delta === null ? lockedTop : scroller.scrollTop + delta;
                if (Math.abs(scroller.scrollTop - desired) > 0.5) {
                    const before = scroller.scrollTop;
                    scroller.scrollTop = desired;
                    if (Math.abs(scroller.scrollTop - before) > 0.5) correctedTop = scroller.scrollTop;
                }
                lockedTop = scroller.scrollTop; // Let the browser clamp either positive or negative scrollTop.
                if (delta === null || Math.abs(lockedTop - desired) > 1 ||
                    (anchor && (!anchor.element.isConnected || (anchor.node && !anchor.node.isConnected)))) capture();
            } finally {
                restoring = false;
            }
        }

        function finishSettling() {
            if (!scroller || !settling) return;
            win.clearTimeout(settleTimer);
            settleTimer = null;
            settling = false;
            protectStyles();
            capture();
            publish();
        }

        function scheduleSettling() {
            win.clearTimeout(settleTimer);
            settleTimer = win.setTimeout(finishSettling, Math.max(0, Math.min(250, settleDeadline - Date.now())));
        }

        function release() {
            win.clearTimeout(settleTimer);
            settleTimer = null;
            if (resizeObserver) resizeObserver.disconnect();
            observedSizes = [];
            if (scroller) {
                for (const entry of savedStyles) {
                    if (!entry.owned || scroller.style.getPropertyValue(entry.name) !== entry.applied || scroller.style.getPropertyPriority(entry.name) !== 'important') continue;
                    if (entry.value) scroller.style.setProperty(entry.name, entry.value, entry.priority);
                    else scroller.style.removeProperty(entry.name);
                }
            }
            savedStyles = [];
            scroller = null;
            anchor = null;
            settling = false;
            draggingScrollbar = false;
            correctedTop = null;
            touch = null;
        }

        function refresh() {
            if (!enabled) return;
            if (route !== win.location.href) {
                route = win.location.href;
                release();
            }
            const nextScroller = findScroller();
            if (nextScroller && nextScroller !== scroller) {
                const preserve = Boolean(scroller && !settling);
                const previousAnchor = anchor;
                const previousTop = lockedTop;
                release();
                scroller = nextScroller;
                if (scroller) {
                    savedStyles = [{ name: 'overflow-anchor', applied: 'none' }, { name: 'scroll-behavior', applied: 'auto' }];
                    if (preserve) {
                        // A same-chat re-render must not reopen the initial-load
                        // grace period and let an old follow-bottom state win.
                        anchor = previousAnchor;
                        lockedTop = previousTop;
                        if (anchor) {
                            const top = viewport().top;
                            const shift = anchor.viewportTop - top;
                            for (const key of ['elementY', 'messageY', 'textY']) {
                                if (Number.isFinite(anchor[key])) anchor[key] += shift;
                            }
                            anchor.viewportTop = top;
                        }
                        protectStyles();
                        observeSizes();
                    } else {
                        // Allow Poe to restore the initial chat position. Only
                        // initial loading/navigation has this grace period.
                        settling = true;
                        settleDeadline = Date.now() + 1500;
                        scheduleSettling();
                    }
                }
            }
            restore();
            publish();
        }

        function scheduleRefresh() {
            if (!enabled || frame !== null) return;
            frame = win.requestAnimationFrame(() => { frame = null; refresh(); });
        }

        function inputBelongsToChat(target) {
            const element = target && (target.nodeType === 1 ? target : target.parentElement);
            if (!scroller || !element || !scroller.contains(element) || element.closest(`${editorSelector},${uiSelector},dialog,[role="dialog"],[role="menu"],[role="listbox"],aside,nav`)) return false;
            for (let parent = element; parent && parent !== scroller; parent = parent.parentElement) {
                if (parent.scrollHeight > parent.clientHeight + 1 && /^(auto|scroll|overlay)$/.test(win.getComputedStyle(parent).overflowY)) return false;
            }
            return true;
        }

        function move(top) {
            finishSettling();
            restore();
            correctedTop = null;
            scroller.scrollTop = top;
            capture();
        }

        function onWheel(event) {
            refresh();
            if (!scroller || !scroller.isConnected) return;
            const path = event.composedPath ? event.composedPath() : [event.target];
            const ownBottom = path.some(element => element && element.id === 'reading-bottom') &&
                path.some(element => element && element.matches && element.matches(uiSelector));
            if (!(inputBelongsToChat(event.target) || bottomButton(event.target) || ownBottom) || event.ctrlKey || event.metaKey || event.shiftKey ||
                !event.deltaY || Math.abs(event.deltaX) > Math.abs(event.deltaY)) return;
            finishSettling();
            restore();
            const line = parseFloat(win.getComputedStyle(scroller).lineHeight) || 20;
            const delta = event.deltaY * (event.deltaMode === 1 ? line : event.deltaMode === 2 ? scroller.clientHeight : 1);
            if (event.cancelable) event.preventDefault();
            // Apply this input ourselves. A time-based "user is scrolling"
            // allowance would also let Poe's jump through after every gesture.
            move(scroller.scrollTop + delta);
        }

        function jumpToBottom() {
            refresh();
            if (!scroller) return;
            move(win.getComputedStyle(scroller).flexDirection === 'column-reverse' ? 0 : scroller.scrollHeight);
        }

        function bottomButton(target) {
            const button = target && target.closest && target.closest('button,[role="button"]');
            if (!button || button.closest(uiSelector)) return false;
            const name = normalizeText(button.getAttribute('aria-label') || button.getAttribute('title') || button.textContent);
            return /^(?:(?:scroll|jump|go)\s+to\s+(?:the\s+)?(?:bottom|latest(?:\s+message)?|newest(?:\s+message)?)|回到底部|滚动到底部|跳[至到](?:底部|最新(?:消息)?)|向下滚动)[.!。！]?$/i.test(name);
        }

        function onKeyDown(event) {
            if (bottomButton(event.target) && (event.key === 'Enter' || event.key === ' ')) { jumpToBottom(); return; }
            refresh();
            const target = event.target;
            if (!scroller || !target || target.closest(`${editorSelector},button,[role="button"],a[href],${uiSelector},dialog,[role="dialog"],[role="menu"],[role="listbox"]`) ||
                event.altKey || event.metaKey || (event.ctrlKey && !['Home', 'End'].includes(event.key))) return;
            if (target !== doc.body && target !== doc.documentElement && !inputBelongsToChat(target)) return;
            const page = scroller.clientHeight * 0.9;
            const deltas = { ArrowUp: -40, ArrowDown: 40, PageUp: -page, PageDown: page, ' ': event.shiftKey ? -page : page };
            if (!(event.key in deltas) && event.key !== 'Home' && event.key !== 'End') return;
            event.preventDefault();
            finishSettling();
            restore();
            const reversed = win.getComputedStyle(scroller).flexDirection === 'column-reverse';
            move(event.key === 'Home' ? (reversed ? -scroller.scrollHeight : 0) :
                event.key === 'End' ? (reversed ? 0 : scroller.scrollHeight) : scroller.scrollTop + deltas[event.key]);
        }

        function onScroll(event) {
            if (!scroller || (event.target !== scroller && !(scroller === doc.scrollingElement && event.target === doc))) return;
            if (settling) scheduleSettling();
            else if (draggingScrollbar) { correctedTop = null; capture(); }
            else {
                const correction = correctedTop !== null && Math.abs(scroller.scrollTop - correctedTop) <= 0.5;
                correctedTop = null;
                restore();
                // Correcting a site-driven jump must not itself trigger Poe's
                // follow-bottom callback again. User scrolls still reach the
                // page, so history loading and normal scroll state can work.
                if (correction || correctedTop !== null) event.stopImmediatePropagation();
            }
        }

        function onPointerDown(event) {
            if (!scroller || event.button !== 0 || (event.pointerType && event.pointerType !== 'mouse')) return;
            const box = viewport();
            if ((event.target === scroller || (scroller === doc.scrollingElement && event.target === doc.documentElement)) &&
                event.clientY >= box.top && event.clientY <= box.bottom &&
                (Math.abs(event.clientX - box.right) < 18 || Math.abs(event.clientX - box.left) < 18)) {
                finishSettling();
                correctedTop = null;
                draggingScrollbar = true;
            }
        }

        function onPointerUp() {
            if (draggingScrollbar && scroller) { draggingScrollbar = false; capture(); }
        }

        function onTouchStart(event) {
            refresh();
            touch = event.touches.length === 1 && inputBelongsToChat(event.target)
                ? { x: event.touches[0].clientX, y: event.touches[0].clientY } : null;
        }

        function onTouchMove(event) {
            if (!touch || event.touches.length !== 1 || !scroller) { touch = null; return; }
            const next = event.touches[0];
            const delta = touch.y - next.clientY;
            const horizontal = Math.abs(touch.x - next.clientX);
            touch = { x: next.clientX, y: next.clientY };
            if (!delta || horizontal > Math.abs(delta)) return;
            if (event.cancelable) event.preventDefault();
            finishSettling();
            restore();
            move(scroller.scrollTop + delta);
        }

        function listen(target, type, handler, options = true) {
            target.addEventListener(type, handler, options);
            listeners.push(() => target.removeEventListener(type, handler, options));
        }

        function start() {
            if (enabled) return;
            enabled = true;
            if (win.ResizeObserver) resizeObserver = new win.ResizeObserver(scheduleRefresh);
            observer = new win.MutationObserver(mutations => {
                if (mutations.some(mutation => {
                    const element = mutation.target.nodeType === 1 ? mutation.target : mutation.target.parentElement;
                    return !element || !element.closest(uiSelector);
                })) scheduleRefresh();
            });
            observer.observe(doc.documentElement, { childList: true, subtree: true, characterData: true,
                attributes: true, attributeFilter: ['class', 'style', 'hidden'] });
            listen(win, 'wheel', onWheel, { capture: true, passive: false });
            listen(doc, 'keydown', onKeyDown);
            listen(win, 'scroll', onScroll);
            const pointer = win.PointerEvent ? 'pointer' : 'mouse';
            listen(doc, `${pointer}down`, onPointerDown);
            listen(doc, `${pointer}up`, onPointerUp);
            listen(doc, 'pointercancel', onPointerUp);
            listen(win, 'blur', event => { if (event.target === win) onPointerUp(); });
            listen(doc, 'touchstart', onTouchStart, { capture: true, passive: true });
            listen(doc, 'touchmove', onTouchMove, { capture: true, passive: false });
            listen(doc, 'touchend', () => { touch = null; });
            listen(doc, 'touchcancel', () => { touch = null; });
            listen(doc, 'click', event => { if (bottomButton(event.target)) jumpToBottom(); });
            listen(doc, 'load', scheduleRefresh);
            listen(win, 'resize', scheduleRefresh);
            listen(win, 'popstate', refresh);
            listen(win, 'hashchange', refresh);
            if (doc.fonts && doc.fonts.addEventListener) listen(doc.fonts, 'loadingdone', scheduleRefresh);
            refresh();
        }

        function stop() {
            enabled = false;
            for (const remove of listeners.splice(0)) remove();
            if (observer) observer.disconnect();
            if (resizeObserver) resizeObserver.disconnect();
            observer = null;
            resizeObserver = null;
            if (frame !== null) win.cancelAnimationFrame(frame);
            frame = null;
            release();
            publish();
        }

        return Object.freeze({ start, stop, refresh, jumpToBottom });
    }

    function parseResetText(value) {
        const lines = String(value || '').split(/[\r\n]+/).map(normalizeText).filter(Boolean);
        const resetPattern = /reset|resets|renew|renews|重置|刷新积分/i;
        for (let index = 0; index < lines.length; index += 1) {
            if (!resetPattern.test(lines[index])) continue;
            resetPattern.lastIndex = 0;
            const text = lines[index].length > 4 ? lines[index] : (lines[index + 1] || lines[index]);
            return text.slice(0, 140);
        }
        return null;
    }

    function botFingerprintFromHref(href, base) {
        try {
            const url = new URL(href, base || 'https://poe.com/');
            const bot = url.searchParams.get('bot');
            return bot ? `bot:${normalizeText(bot).toLowerCase()}` : null;
        } catch (_) {
            return null;
        }
    }

    async function retryBounded(operation, maxAttempts, waitBeforeRetry, onError) {
        const attempts = Math.max(1, Math.floor(maxAttempts) || 1);
        let lastError = null;
        for (let attempt = 0; attempt < attempts; attempt += 1) {
            try {
                return await operation();
            } catch (error) {
                lastError = error;
                if (onError) onError(error, attempt);
                if (attempt + 1 < attempts && waitBeforeRetry) await waitBeforeRetry(attempt, error);
            }
        }
        throw lastError || new Error('操作失败');
    }

    function createSingleFlight() {
        let active = null;
        return function run(operation) {
            if (active) return active;
            const promise = Promise.resolve().then(operation).finally(() => {
                if (active === promise) active = null;
            });
            active = promise;
            return promise;
        };
    }

    function decideSend(effort, settings, manualOverride) {
        if (!settings || !settings.sendGuard) return { action: 'allow', reason: 'guard-off' };
        if (effort && effort.kind === 'unsupported') return { action: 'allow', reason: 'unsupported' };
        if (effort && effort.level === 'low') return { action: 'allow', reason: 'verified-low' };
        if (effort && effort.level && LEVELS.includes(effort.level) && manualOverride) {
            return { action: 'allow', reason: 'manual-choice' };
        }
        if (effort && effort.level && LEVELS.includes(effort.level)) {
            return { action: 'set-low', reason: 'non-low-unconfirmed' };
        }
        if (settings.strictGuard) return { action: 'block', reason: 'effort-unknown' };
        return { action: 'allow', reason: 'effort-unknown-warning' };
    }

    function start(win) {
        if (!win || !win.document || win[INSTANCE_KEY]) return win && win[INSTANCE_KEY];
        const doc = win.document;
        const timers = new Set();
        const timeouts = new Set();
        const pendingDelays = new Map();
        let running = true;
        const monotonicNow = () => win.performance && typeof win.performance.now === 'function' ? win.performance.now() : Date.now();
        const scriptStartedAt = monotonicNow();

        function timeout(callback, ms) {
            const id = win.setTimeout(() => {
                timeouts.delete(id);
                if (running) callback();
            }, ms);
            timeouts.add(id);
            return id;
        }

        function clearTimeoutTracked(id) {
            if (!id) return;
            win.clearTimeout(id);
            timeouts.delete(id);
        }

        function interval(callback, ms) {
            const id = win.setInterval(() => {
                if (running) callback();
            }, ms);
            timers.add(id);
            return id;
        }

        function clearTimers() {
            for (const id of timers) win.clearInterval(id);
            for (const id of timeouts) win.clearTimeout(id);
            timers.clear();
            timeouts.clear();
            for (const resolve of pendingDelays.values()) resolve();
            pendingDelays.clear();
        }

        function delay(ms) {
            return new Promise(resolve => {
                const id = win.setTimeout(() => {
                    timeouts.delete(id);
                    pendingDelays.delete(id);
                    resolve();
                }, ms);
                timeouts.add(id);
                pendingDelays.set(id, resolve);
            });
        }

        function waitAbortable(ms, signal) {
            return new Promise(resolve => {
                let id = null;
                const done = () => {
                    clearTimeoutTracked(id);
                    if (id !== null) pendingDelays.delete(id);
                    signal.removeEventListener('abort', done);
                    resolve();
                };
                if (signal.aborted) return resolve();
                id = timeout(done, ms);
                pendingDelays.set(id, done);
                signal.addEventListener('abort', done, { once: true });
            });
        }

        const state = {
            settings: { ...DEFAULT_SETTINGS },
            points: null,
            resetText: null,
            pointsUpdatedAt: 0,
            pointsStatus: '尚未读取',
            remainingPercent: null,
            percentUpdatedAt: 0,
            roundUsage: { points: null, status: 'loading' },
            effortStatus: { kind: 'unknown', level: null, label: 'None' },
            readingPosition: { status: 'waiting', canJump: false },
            statusMessage: '正在检查 Poe 页面…',
            allowOnce: false
        };

        function log(...args) {
            if (state.settings.debug) console.info('[Poe Effort & Points]', ...args);
        }

        async function readSetting(key, fallback) {
            try {
                const gmApi = typeof GM !== 'undefined' ? GM : null;
                const getter = gmApi && typeof gmApi.getValue === 'function'
                    ? (settingKey, defaultValue) => gmApi.getValue(settingKey, defaultValue)
                    : typeof GM_getValue === 'function'
                        ? (settingKey, defaultValue) => GM_getValue(settingKey, defaultValue)
                        : null;
                if (!getter) return fallback;
                const value = getter(key, fallback);
                return value && typeof value.then === 'function' ? await value : value;
            } catch (error) {
                log('读取设置失败', error);
                return fallback;
            }
        }

        function waitForDocumentReady() {
            if (doc.documentElement && doc.body) return Promise.resolve();
            return new Promise(resolve => doc.addEventListener('DOMContentLoaded', resolve, { once: true }));
        }

        async function saveSettings() {
            try {
                const gmApi = typeof GM !== 'undefined' ? GM : null;
                const setter = gmApi && typeof gmApi.setValue === 'function'
                    ? (settingKey, settingValue) => gmApi.setValue(settingKey, settingValue)
                    : typeof GM_setValue === 'function'
                        ? (settingKey, settingValue) => GM_setValue(settingKey, settingValue)
                        : null;
                if (!setter) return;
                const value = setter(SETTINGS_KEY, state.settings);
                if (value && typeof value.then === 'function') await value;
            } catch (error) {
                log('保存设置失败', error);
            }
        }

        function loadSavedManualContext() {
            try {
                return win.sessionStorage.getItem(MANUAL_CONTEXT_KEY) || null;
            } catch (_) {
                return null;
            }
        }

        function saveManualContext(value) {
            try {
                if (value) win.sessionStorage.setItem(MANUAL_CONTEXT_KEY, value);
                else win.sessionStorage.removeItem(MANUAL_CONTEXT_KEY);
            } catch (_) {
                // Private browsing settings may disable sessionStorage; in-memory handling still works.
            }
        }

        class UIManager {
            constructor() {
                this.host = null;
                this.root = null;
                this.allowButton = null;
                this.onSettingChange = null;
                this.onAllowOnce = null;
                this.onJumpToBottom = null;
            }

            mount() {
                if (this.host && this.host.isConnected) return;
                const existing = doc.querySelector('[data-poe-effort-points-ui="root"]');
                if (existing) existing.remove();
                this.host = doc.createElement('div');
                this.host.setAttribute('data-poe-effort-points-ui', 'root');
                this.host.setAttribute('aria-live', 'polite');
                this.root = this.host.attachShadow ? this.host.attachShadow({ mode: 'open' }) : this.host;
                this.root.innerHTML = `
                    <style>
                        :host { all: initial; }
                        .panel { position: fixed; top: 68px; right: 14px; z-index: 2147483000;
                            max-width: min(360px, calc(100vw - 28px)); color: #202124;
                            font: 12px/1.45 -apple-system, BlinkMacSystemFont, "Segoe UI", sans-serif;
                            pointer-events: auto; }
                        .card { border: 1px solid rgba(128,128,128,.28); border-radius: 10px;
                            background: color-mix(in srgb, Canvas 94%, transparent); color: CanvasText;
                            box-shadow: 0 4px 18px rgba(0,0,0,.16); backdrop-filter: blur(12px); }
                        summary { cursor: pointer; list-style: none; padding: 9px 11px; }
                        summary::-webkit-details-marker { display:none; }
                        .headline { display:flex; flex-wrap:wrap; gap: 4px 12px; font-weight: 600; }
                        .body { border-top: 1px solid rgba(128,128,128,.24); padding: 8px 11px 10px; }
                        .row { display:flex; justify-content:space-between; gap:14px; margin:3px 0; }
                        .value { text-align:right; overflow-wrap:anywhere; }
                        .status { margin:7px 0; color: color-mix(in srgb, CanvasText 72%, #777); }
                        .settings { display:grid; gap:5px; margin-top:8px; }
                        label { display:flex; align-items:center; gap:7px; cursor:pointer; }
                        input { accent-color:#6b70d6; }
                        button { border:1px solid rgba(128,128,128,.38); border-radius:6px;
                            padding:5px 8px; background:ButtonFace; color:ButtonText; cursor:pointer; }
                        .allow { margin-top:6px; }
                        .reading-tools { display:flex; justify-content:flex-end; margin-top:5px; }
                        .note { margin-top:7px; opacity:.72; }
                        @media (prefers-color-scheme: dark) {
                            .card { border-color:rgba(255,255,255,.18); }
                        }
                        @media (max-width: 520px) {
                            .panel { top: 52px; right: 8px; max-width:calc(100vw - 16px); }
                        }
                    </style>
                    <div class="panel">
                        <details class="card">
                            <summary>
                                <div class="headline"><span id="usage-short">本次用量：未知</span><span id="percent-short">剩余：未知</span><span id="effort-short">Effort：None</span></div>
                            </summary>
                            <div class="body">
                                <div class="row"><span>剩余积分比例</span><span class="value" id="percent">未知</span></div>
                                <div class="row"><span>积分重置</span><span class="value" id="reset">未知</span></div>
                                <div class="row"><span>最近一轮用量</span><span class="value" id="usage">读取中</span></div>
                                <div class="row"><span>Effort</span><span class="value" id="effort">检测中</span></div>
                                <div class="row"><span>阅读位置</span><span class="value" id="reading-state">等待聊天</span></div>
                                <div class="status" id="status" role="status">正在检查 Poe 页面…</div>
                                <button class="allow" id="allow-once" type="button" hidden>本次允许发送</button>
                                <div class="settings">
                                    <label><input id="auto-low" type="checkbox"> 自动选择 Low</label>
                                    <label><input id="send-guard" type="checkbox"> 发送前保护</label>
                                    <label><input id="strict-guard" type="checkbox"> 严格保护（未知时拦截）</label>
                                    <label><input id="reading-lock" type="checkbox"> 固定阅读位置（阻止自动跳动）</label>
                                    <label><input id="debug" type="checkbox"> 调试日志</label>
                                </div>
                                <div class="note" id="usage-note">本次用量是最近一轮回复的官方费用。</div>
                            </div>
                        </details>
                        <div class="reading-tools"><button id="reading-bottom" type="button" hidden>回到底部</button></div>
                    </div>`;
                (doc.body || doc.documentElement).appendChild(this.host);
                this.allowButton = this.root.querySelector('#allow-once');
                this.root.querySelector('#allow-once').addEventListener('click', () => {
                    if (this.onAllowOnce) this.onAllowOnce();
                });
                this.root.querySelector('#reading-bottom').addEventListener('click', () => {
                    if (this.onJumpToBottom) this.onJumpToBottom();
                });
                for (const [id, key] of [['auto-low', 'autoLow'], ['send-guard', 'sendGuard'], ['strict-guard', 'strictGuard'], ['reading-lock', 'readingLock'], ['debug', 'debug']]) {
                    const input = this.root.querySelector(`#${id}`);
                    input.checked = Boolean(state.settings[key]);
                    input.disabled = true;
                    input.addEventListener('change', () => {
                        state.settings[key] = input.checked;
                        if (this.onSettingChange) this.onSettingChange(key, input.checked);
                        this.render();
                    });
                }
                this.render();
            }

            setSettingsEnabled(enabled) {
                if (!this.root) return;
                for (const input of this.root.querySelectorAll('.settings input')) input.disabled = !enabled;
            }

            showAllowOnce(show) {
                if (this.allowButton) this.allowButton.hidden = !show;
            }

            render() {
                if (!this.root) return;
                const reset = state.resetText || '未知';
                const percent = state.remainingPercent === null
                    ? '未知'
                    : `${state.remainingPercent}%${Date.now() - state.percentUpdatedAt > 10 * 60 * 1000 ? '（待更新）' : ''}`;
                const usageState = state.roundUsage;
                const usage = roundUsageText(usageState);
                const effort = effortDisplayName(state.effortStatus);
                this.root.querySelector('#percent').textContent = percent;
                this.root.querySelector('#percent-short').textContent = `剩余：${percent}`;
                this.root.querySelector('#reset').textContent = reset;
                this.root.querySelector('#usage').textContent = usage;
                this.root.querySelector('#usage-short').textContent = `本次用量：${usage}`;
                this.root.querySelector('#usage-note').textContent = usageState.status === 'settled'
                    ? '当前聊天最近一轮的官方任务总费用，包含输入、输出与折扣；每轮分别显示。'
                    : usageState.status === 'idle' ? '当前聊天尚无回复。发送并完成一轮后显示费用。'
                        : usageState.status === 'loading' ? '正在后台读取当前聊天最近一轮的官方费用。'
                            : usageState.status === 'pending'
                                ? `正在等待回复或 Poe 结算。${usageState.retryStopped ? '本轮重试已结束，返回此标签页时可重新核对。' : ''}`
                                : `官方费用读取失败或尚未提供${usageState.failureReason ? `（${usageState.failureReason}）` : ''}；返回此标签页时重新核对。`;
                this.root.querySelector('#effort').textContent = effort;
                this.root.querySelector('#effort-short').textContent = `Effort：${effort}`;
                this.root.querySelector('#reading-state').textContent = ({ off: '已关闭', waiting: '等待聊天', settling: '页面载入中', locked: '已固定，可手动滚动' })[state.readingPosition.status];
                const bottom = this.root.querySelector('#reading-bottom');
                bottom.hidden = !state.settings.readingLock || !state.readingPosition.canJump;
                this.root.querySelector('#status').textContent = state.statusMessage;
                for (const [id, key] of [['auto-low', 'autoLow'], ['send-guard', 'sendGuard'], ['strict-guard', 'strictGuard'], ['reading-lock', 'readingLock'], ['debug', 'debug']]) {
                    const input = this.root.querySelector(`#${id}`);
                    if (input) input.checked = Boolean(state.settings[key]);
                }
            }

            destroy() {
                if (this.host && this.host.isConnected) this.host.remove();
                this.host = null;
                this.root = null;
            }
        }

        const ui = new UIManager();
        const readingGuard = createReadingPositionGuard(win, readingPosition => {
            state.readingPosition = readingPosition;
            ui.render();
        });

        function visible(element) {
            if (!element || !element.isConnected || element.hidden || element.getAttribute('aria-hidden') === 'true') return false;
            try {
                const style = win.getComputedStyle(element);
                if (style.display === 'none' || style.visibility === 'hidden' || Number(style.opacity) === 0) return false;
                return element.getClientRects().length > 0;
            } catch (_) {
                return true;
            }
        }

        function accessibleName(element) {
            if (!element) return '';
            const labelledBy = normalizeText((element.getAttribute('aria-labelledby') || '').split(/\s+/)
                .map(id => doc.getElementById(id))
                .filter(Boolean)
                .map(node => node.textContent)
                .join(' '));
            // Follow accessible-name precedence. Concatenating ARIA labels with
            // descendant text can turn one value (for example "High") into an
            // ambiguous duplicate and cause the conservative parser to reject it.
            return labelledBy || normalizeText(element.getAttribute('aria-label')) ||
                normalizeText(element.getAttribute('aria-valuetext')) ||
                normalizeText(element.getAttribute('title')) ||
                normalizeText(element.innerText || element.textContent);
        }

        function findComposer() {
            const candidates = Array.from(doc.querySelectorAll('textarea,[contenteditable="true"],[role="textbox"]'))
                .filter(element => visible(element) && !element.closest('[data-poe-effort-points-ui="root"]'));
            return candidates[candidates.length - 1] || null;
        }

        function composerText(composer) {
            if (!composer) return '';
            if ('value' in composer && typeof composer.value === 'string') return normalizeText(composer.value);
            return normalizeText(composer.innerText || composer.textContent);
        }

        class PointsService {
            constructor() {
                this.runSingleFlight = createSingleFlight();
                this.requests = new Set();
                this.roundReader = createRoundCostReader({
                    readChat: async (chatCode, options) => parseChatPageData(
                        this.nextData(await this.requestPage(`/chat/${chatCode}`, options)), chatCode),
                    readMessage: async (message, chatId, options) => parseMessageCostData(
                        this.nextData(await this.requestPage(`/message/${message.code}`, options)), chatId, message),
                    wait: waitAbortable,
                    makeController: () => new win.AbortController(),
                    onUpdate: usage => {
                        if (!running || usage.chatCode !== this.chatId()) return;
                        state.roundUsage = usage;
                        ui.render();
                        log('单轮官方费用状态', { status: usage.status, settled: usage.status === 'settled' });
                    }
                });
            }

            chatId() {
                return chatIdFromHref(win.location.href);
            }

            refreshUsage() {
                this.roundReader.cancel();
                state.roundUsage = { points: null, status: this.chatId() ? 'loading' : 'idle' };
                ui.render();
            }

            markRoundPending(messageId) {
                this.roundReader.cancel();
                state.roundUsage = { points: null, status: 'pending', messageId };
                ui.render();
            }

            async refreshRound(messageId) {
                const chatCode = this.chatId();
                if (!chatCode) {
                    state.roundUsage = { points: null, status: 'idle' };
                    ui.render();
                    return;
                }
                if (messageId && state.roundUsage.status === 'settled' && state.roundUsage.messageId === String(messageId)) return;
                try {
                    await this.roundReader.start(chatCode, messageId);
                } catch (_) {
                    // Navigation/teardown cancels the old task; it must not write
                    // an error into the new chat or interfere with sending.
                }
            }

            nextData(html) {
                const parsed = new win.DOMParser().parseFromString(html, 'text/html');
                const script = parsed.getElementById('__NEXT_DATA__');
                if (!script) throw new Error('Poe 页面未提供官方消息资料');
                return JSON.parse(script.textContent);
            }

            abortRequests() {
                this.roundReader.cancel();
                for (const request of Array.from(this.requests)) request.abort();
            }

            updateNativePercent() {
                const bodyText = doc.body && (doc.body.innerText || doc.body.textContent);
                const percent = parseRemainingPercent(bodyText || '');
                if (percent !== null) {
                    const changed = percent !== state.remainingPercent;
                    const wasStale = Date.now() - state.percentUpdatedAt > 10 * 60 * 1000;
                    state.remainingPercent = percent;
                    state.percentUpdatedAt = Date.now();
                    if (changed || wasStale) ui.render();
                    if (changed) log('Poe 原生剩余百分比已更新', percent);
                }
                return state.remainingPercent;
            }

            parseDocument(html) {
                const parsed = new win.DOMParser().parseFromString(html, 'text/html');
                const body = parsed.body;
                let text = body ? (body.innerText || body.textContent || '') : '';
                if (body && typeof parsed.createTreeWalker === 'function' && (!text || !/[\r\n]/.test(text))) {
                    const walker = parsed.createTreeWalker(body, win.NodeFilter.SHOW_TEXT);
                    const pieces = [];
                    let node;
                    while ((node = walker.nextNode())) {
                        const value = normalizeText(node.nodeValue);
                        if (value) pieces.push(value);
                    }
                    text = pieces.join('\n');
                }
                const points = parsePointsBalance(text);
                const resetText = parseResetText(text);
                if (points === null) throw new Error('未能从设置页的可见语义文本中确认积分余额');
                return { points, resetText };
            }

            requestPage(path, { signal, timeout: timeoutMs = 10000 } = {}) {
                if (!/^\/(?:settings|chat\/[a-zA-Z0-9_-]+|message\/[a-zA-Z0-9_-]+)$/.test(path)) {
                    return Promise.reject(new Error('积分读取地址不在已验证的 Poe 页面范围内'));
                }
                const gmApi = typeof GM !== 'undefined' ? GM : null;
                // Safari Userscripts' extension request can return a logged-out
                // document. A normal same-origin GET keeps Poe's existing page
                // session without reading any credentials or request headers.
                const request = typeof win.fetch === 'function' ? options => {
                    const controller = new win.AbortController();
                    const promise = win.fetch(options.url, {
                        method: 'GET', credentials: 'same-origin', cache: 'no-store', signal: controller.signal
                    }).then(async response => ({
                        status: response.status, finalUrl: response.url, responseText: await response.text()
                    }));
                    promise.abort = () => controller.abort();
                    return promise;
                } : typeof GM_xmlhttpRequest === 'function' ? GM_xmlhttpRequest
                    : gmApi && typeof gmApi.xmlHttpRequest === 'function' ? gmApi.xmlHttpRequest.bind(gmApi) : null;
                if (!request) return Promise.reject(new Error('用户脚本的只读请求功能不可用'));
                return new Promise((resolve, reject) => {
                    let settled = false;
                    let handle = null;
                    let timer = null;
                    const tracked = { abort: () => {
                        finish(reject, new Error('Poe 页面读取已取消'));
                        if (handle && typeof handle.abort === 'function') {
                            try { handle.abort(); } catch (_) { /* Already completed in the script manager. */ }
                        }
                    } };
                    const finish = (callback, value) => {
                        if (settled) return;
                        settled = true;
                        clearTimeoutTracked(timer);
                        this.requests.delete(tracked);
                        if (signal) signal.removeEventListener('abort', tracked.abort);
                        callback(value);
                    };
                    const onload = response => {
                        if (settled) return;
                        if (!response || typeof response.status !== 'number') {
                            finish(reject, new Error('用户脚本未返回有效的 Poe 页面响应'));
                            return;
                        }
                        if (response.status < 200 || response.status >= 400) {
                            finish(reject, new Error(`Poe 页面读取失败（HTTP ${response.status}）`));
                            return;
                        }
                        try {
                            if (response.finalUrl) {
                                const final = new URL(response.finalUrl);
                                if (!['poe.com', 'www.poe.com'].includes(final.hostname) || final.pathname !== path) {
                                    finish(reject, new Error('Poe 页面跳转，无法确认官方资料'));
                                    return;
                                }
                            }
                        } catch (_) {
                            finish(reject, new Error('Poe 页面地址无法确认'));
                            return;
                        }
                        finish(resolve, response.responseText || '');
                    };
                    if (signal && signal.aborted) return tracked.abort();
                    this.requests.add(tracked);
                    if (signal) signal.addEventListener('abort', tracked.abort, { once: true });
                    timer = timeout(() => tracked.abort(), Math.max(1, timeoutMs));
                    try {
                        handle = request({
                            method: 'GET',
                            url: `${win.location.origin}${path}`,
                            timeout: Math.max(1, timeoutMs),
                            nocache: true,
                            onload,
                            onerror: () => finish(reject, new Error('Poe 页面读取网络错误')),
                            ontimeout: () => finish(reject, new Error('Poe 页面读取超时')),
                            onabort: () => finish(reject, new Error('Poe 页面读取已取消'))
                        });
                        // Userscripts also exposes the Promise-style GM API.
                        if (handle && typeof handle.then === 'function') handle.then(onload, error => finish(reject, error));
                    } catch (error) {
                        finish(reject, error);
                    }
                });
            }

            async requestOnce() {
                return this.parseDocument(await this.requestPage('/settings'));
            }

            refresh(reason) {
                return this.runSingleFlight(async () => {
                    state.pointsStatus = '正在读取';
                    ui.render();
                    try {
                        const result = await retryBounded(
                            () => this.requestOnce(),
                            3,
                            attempt => {
                                if (!running) throw new Error('页面已离开');
                                return delay(attempt === 0 ? 600 : 1200);
                            },
                            (error, attempt) => log(`积分读取第 ${attempt + 1} 次失败`, error)
                        );
                        if (!running) return null;
                        state.points = result.points;
                        state.resetText = result.resetText;
                        state.pointsUpdatedAt = Date.now();
                        state.pointsStatus = '已更新';
                        this.updateNativePercent();
                        ui.render();
                        log('设置页积分数据已读取');
                        return result;
                    } catch (error) {
                        if (running) {
                            state.points = null;
                            state.resetText = null;
                            state.pointsStatus = '未知';
                            this.updateNativePercent();
                            ui.render();
                        }
                        throw error;
                    }
                });
            }

            async refreshQuietly(reason) {
                try {
                    return await this.refresh(reason);
                } catch (_) {
                    return null;
                }
            }
        }

        const pointsService = new PointsService();

        class EffortManager {
            constructor() {
                this.busy = false;
                this.scanPromise = null;
                this.scanRequested = false;
                this.autoSelecting = 0;
                this.lastAttemptKey = '';
                this.lastAttemptAt = 0;
                this.lastControlProbeContext = '';
                this.lastControlProbeAt = 0;
                this.lastKnown = null;
                this.retryTimer = null;
                this.retryContext = '';
                this.retryStartedAt = 0;
                this.retryCount = 0;
                this.userChoiceVersion = 0;
                this.manualInteractionUntil = 0;
                this.contextProvider = () => '';
                this.manualOverrideProvider = () => false;
                this.setManualOverrideProvider = () => {};
                this.manualPendingProvider = () => null;
                this.setManualPendingProvider = () => {};
                this.onState = null;
            }

            invalidateContextEvidence() {
                if (this.retryTimer) {
                    win.clearTimeout(this.retryTimer);
                    timeouts.delete(this.retryTimer);
                }
                this.retryTimer = null;
                this.retryContext = '';
                this.retryStartedAt = 0;
                this.retryCount = 0;
                this.manualInteractionUntil = 0;
                this.lastKnown = null;
                this.lastAttemptKey = '';
                this.lastAttemptAt = 0;
                this.lastControlProbeContext = '';
                this.lastControlProbeAt = 0;
            }

            isEffortLabel(element) {
                const name = normalizeText(accessibleName(element)).toLowerCase();
                return /^(?:output\s+)?effort(?:\s+(?:setting|level))?$/.test(name) || /^推理强度(?:设置|档位)?$/.test(name);
            }

            effortLabelsWithin(container) {
                if (!container || !container.querySelectorAll) return [];
                // Poe currently renders "Output Effort" as a button with a <p>
                // label and places the value select beside it in the same card.
                // Include plain text elements, but accept only an exact label.
                const selector = 'button,[role="button"],[role="heading"],label,[aria-label],[aria-labelledby],h1,h2,h3,h4,legend,p,span';
                return Array.from(container.querySelectorAll(selector))
                    .filter(element => visible(element) && this.isEffortLabel(element));
            }

            effortSelectGroup(select) {
                let ancestor = select && select.parentElement;
                for (let depth = 0; ancestor && depth < 10; depth += 1, ancestor = ancestor.parentElement) {
                    const labels = this.effortLabelsWithin(ancestor);
                    const selects = Array.from(ancestor.querySelectorAll('select'));
                    if (labels.length && selects.length === 1 && selects[0] === select) return ancestor;
                }
                return null;
            }

            findEffortSelects() {
                return Array.from(doc.querySelectorAll('select')).filter(select => {
                    const options = Array.from(select.options || []).map(option => ({
                        value: option.value,
                        text: option.textContent
                    }));
                    const group = this.effortSelectGroup(select);
                    return isEffortSelectOptions(options) && group && visible(group);
                });
            }

            belongsToEffortGroup(element) {
                let ancestor = element && element.parentElement;
                for (let depth = 0; ancestor && depth < 8; depth += 1, ancestor = ancestor.parentElement) {
                    if (this.effortLabelsWithin(ancestor).length) return true;
                }
                return false;
            }

            isPopupControl(element) {
                if (!element) return false;
                const role = (element.getAttribute('role') || '').toLowerCase();
                return element.tagName === 'SELECT' ||
                    role === 'combobox' || role === 'listbox' ||
                    element.hasAttribute('aria-haspopup') ||
                    element.hasAttribute('aria-expanded') ||
                    // Some Poe builds expose the current choice as a plain button
                    // with no popup ARIA. It is accepted only inside the unique
                    // group anchored by an exact "Output Effort" label.
                    (element.tagName === 'BUTTON' && this.belongsToEffortGroup(element));
            }

            findControls() {
                const effortSelects = this.findEffortSelects();
                // Poe's current Effort widget uses a native <select> with exact
                // level options. Prefer it over its less descriptive wrapper.
                if (effortSelects.length) return effortSelects;
                const selector = 'button,[role="button"],[role="combobox"],[aria-haspopup],[aria-expanded]';
                return Array.from(doc.querySelectorAll(selector))
                    .filter(element => visible(element) && !element.closest('[data-poe-effort-points-ui="root"]'))
                    .filter(element => {
                        if (!this.isPopupControl(element) || !parseEffortLevel(accessibleName(element))) return false;
                        const name = accessibleName(element);
                        return /\beffort\b|推理强度/i.test(name) || this.belongsToEffortGroup(element);
                    });
            }

            findExplicitUnavailableControl() {
                const selector = 'button,[role="button"],[role="combobox"],[aria-disabled="true"],[disabled]';
                const candidates = Array.from(doc.querySelectorAll(selector))
                    .filter(element => visible(element) && !element.closest('[data-poe-effort-points-ui="root"]'))
                    .filter(element => isExplicitlyUnavailableEffort(
                        accessibleName(element),
                        Boolean(element.disabled || element.getAttribute('aria-disabled') === 'true')
                    ));
                return candidates.length === 1 ? candidates[0] : null;
            }

            findControl() {
                const controls = Array.from(new Set(this.findControls()));
                return controls.length === 1 ? controls[0] : null;
            }

            findEffortActivator() {
                const pattern = /^(?:extra\s+inputs?|additional\s+inputs?|额外输入|附加输入)$/i;
                const candidates = Array.from(doc.querySelectorAll('button,[role="button"],[aria-haspopup]'))
                    .filter(element => visible(element) && !element.closest('[data-poe-effort-points-ui="root"]'))
                    // Safari may expose Poe's uniquely named composer popup
                    // outside the form subtree found by isComposerControl().
                    // Exact naming plus uniqueness keeps this a narrow target.
                    .filter(element => pattern.test(accessibleName(element)));
                return candidates.length === 1 ? candidates[0] : null;
            }

            findEffortSectionToggle() {
                const selector = 'button,[role="button"],[aria-expanded]';
                const candidates = Array.from(doc.querySelectorAll(selector))
                    .filter(element => visible(element) && !element.closest('[data-poe-effort-points-ui="root"]'))
                    .filter(element => this.isEffortLabel(element) || (
                        element.hasAttribute('aria-expanded') && element.hasAttribute('aria-controls') &&
                        this.effortLabelsWithin(element).length === 1
                    ));
                return candidates.length === 1 ? candidates[0] : null;
            }

            levelInElement(element) {
                if (!element) return null;
                if (element.tagName === 'SELECT') {
                    const value = parseEffortLevel(element.value);
                    const selectedOptions = Array.from(element.options || []).filter(option => option.selected);
                    if (selectedOptions.length !== 1) return null;
                    return parseEffortLevel(selectedOptions[0].value) === value &&
                        parseEffortLevel(selectedOptions[0].textContent) === value ? value : null;
                }
                const selected = Array.from(element.querySelectorAll('[aria-checked="true"],[aria-selected="true"],[aria-pressed="true"],[data-state="checked"],[data-selected="true"]'))
                    .filter(visible)
                    .map(node => parseEffortLevel(accessibleName(node)))
                    .filter(Boolean);
                const selectedUnique = Array.from(new Set(selected));
                if (selectedUnique.length === 1) return selectedUnique[0];
                if (selectedUnique.length > 1) return null;
                return parseEffortLevel(accessibleName(element));
            }

            inspect() {
                const control = this.findControl();
                if (!control) {
                    const unavailableControl = this.findExplicitUnavailableControl();
                    if (unavailableControl) {
                        return { kind: 'unsupported', level: null, control: unavailableControl, label: '不支持 Effort' };
                    }
                    const context = this.contextProvider();
                    if (this.lastKnown && this.lastKnown.context === context) {
                        const manual = this.manualOverrideProvider() && this.lastKnown.level !== 'low';
                        const levelName = this.lastKnown.level[0].toUpperCase() + this.lastKnown.level.slice(1);
                        return {
                            kind: 'supported', level: this.lastKnown.level, control: null, cached: true,
                            label: `${levelName}${manual ? '（手动）' : '（最近已验证）'}`
                        };
                    }
                    return { kind: 'unknown', level: null, control: null, label: '未能确认 Effort 控件' };
                }
                const name = accessibleName(control);
                const explicitlyUnavailable = isExplicitlyUnavailableEffort(
                    name,
                    Boolean(control.disabled || control.getAttribute('aria-disabled') === 'true')
                );
                if (explicitlyUnavailable) return { kind: 'unsupported', level: null, control, label: '不支持 Effort' };
                const level = this.levelInElement(control);
                if (!level) return { kind: 'unknown', level: null, control, label: 'Effort 状态未确认' };
                const context = this.contextProvider();
                if (this.lastControlSeenContext !== context) {
                    this.lastControlSeenContext = context;
                    log('页面 Effort 控件已出现', { elapsedMs: Math.round(monotonicNow() - scriptStartedAt) });
                }
                this.lastKnown = { context, level };
                const manual = this.manualOverrideProvider();
                return { kind: 'supported', level, control, label: `${level[0].toUpperCase()}${level.slice(1)}${manual && level !== 'low' ? '（手动）' : ''}` };
            }

            modelFingerprint() {
                const botLinks = Array.from(doc.querySelectorAll('a[href]'))
                    .filter(element => visible(element) && !element.closest('[data-poe-effort-points-ui="root"]'))
                    .map(element => botFingerprintFromHref(element.href || element.getAttribute('href'), win.location.href))
                    .filter(Boolean);
                const uniqueBotLinks = Array.from(new Set(botLinks));
                if (uniqueBotLinks.length === 1) return uniqueBotLinks[0];

                const composer = findComposer();
                const excluded = /effort|send|stop|发送|提交|停止|附件|attach|voice|dictat|mic|settings|设置/i;
                if (composer) {
                    let ancestor = composer.parentElement;
                    for (let depth = 0; ancestor && depth < 10; depth += 1, ancestor = ancestor.parentElement) {
                        const candidates = Array.from(ancestor.querySelectorAll('button,[role="combobox"],[aria-haspopup]'))
                            .filter(element => visible(element) && !element.closest('[data-poe-effort-points-ui="root"]'))
                            .map(element => ({ element, name: accessibleName(element) }))
                            .filter(item => item.name && item.name.length < 100 && !excluded.test(item.name));
                        const modelNamed = candidates.filter(item => /model|bot|模型|机器人/i.test(item.name));
                        const choices = modelNamed.length ? modelNamed : candidates.filter(item => item.element.getAttribute('aria-haspopup') || item.element.getAttribute('role') === 'combobox');
                        if (choices.length && choices.length <= 3) return choices.map(item => item.name.toLowerCase()).join('|');
                    }
                }
                const modelPattern = /\b(?:claude|gpt[-\s]?\w+|o[1-9](?:[-\s]\w+)?|gemini|deepseek|grok|qwen|llama|mistral)\b/i;
                const labels = Array.from(doc.querySelectorAll('button,[role="combobox"],[aria-haspopup]'))
                    .filter(element => visible(element) && !element.closest('[data-poe-effort-points-ui="root"]'))
                    .map(accessibleName)
                    .filter(name => name && name.length < 100 && modelPattern.test(name));
                return labels.length === 1 ? labels[0].toLowerCase() : '';
            }

            menuRoots(control) {
                if (!control) return [];
                const roots = Array.from(doc.querySelectorAll('[role="menu"],[role="listbox"],[role="dialog"]')).filter(visible);
                const ids = `${control.getAttribute('aria-controls') || ''} ${control.getAttribute('aria-owns') || ''}`.split(/\s+/).filter(Boolean);
                const controlled = ids.map(id => doc.getElementById(id)).filter(Boolean).filter(visible);
                const byLabel = control.id ? roots.filter(root => (root.getAttribute('aria-labelledby') || '').split(/\s+/).includes(control.id)) : [];
                const related = Array.from(new Set([...controlled, ...byLabel]));
                if (related.length) return related;
                if (control.getAttribute('aria-expanded') === 'true' && roots.length === 1) return roots;
                if (control.getAttribute('aria-expanded') === 'true') {
                    const effortNamed = roots.filter(root => /effort|推理强度/i.test(accessibleName(root)));
                    if (effortNamed.length === 1) return effortNamed;
                }
                return [];
            }

            lowOption(menu) {
                const options = Array.from(menu.querySelectorAll('button,[role="menuitem"],[role="menuitemradio"],[role="option"],[role="radio"]'))
                    .filter(visible)
                    .filter(element => parseEffortLevel(accessibleName(element)) === 'low');
                return options.length === 1 ? options[0] : null;
            }

            selectLow(control) {
                if (!control || control.tagName !== 'SELECT') return false;
                const options = Array.from(control.options || []).filter(option =>
                    normalizeText(option.value).toLowerCase() === 'low' && parseEffortLevel(option.textContent) === 'low'
                );
                if (options.length !== 1) return false;
                const nativeSetter = win.HTMLSelectElement &&
                    Object.getOwnPropertyDescriptor(win.HTMLSelectElement.prototype, 'value');
                if (nativeSetter && typeof nativeSetter.set === 'function') nativeSetter.set.call(control, options[0].value);
                else control.value = options[0].value;
                control.dispatchEvent(new win.Event('input', { bubbles: true }));
                control.dispatchEvent(new win.Event('change', { bubbles: true }));
                return true;
            }

            optionIsSelected(option) {
                if (!option) return false;
                return option.getAttribute('aria-checked') === 'true' || option.getAttribute('aria-selected') === 'true' ||
                    option.getAttribute('aria-pressed') === 'true' || option.getAttribute('data-state') === 'checked' ||
                    option.getAttribute('data-selected') === 'true' || option.getAttribute('aria-current') === 'true';
            }

            selectedMenuLevel() {
                const control = this.findControl();
                if (!control) return null;
                if (control.tagName === 'SELECT') return this.levelInElement(control);
                const menus = this.menuRoots(control);
                if (menus.length !== 1) return null;
                const selected = Array.from(menus[0].querySelectorAll('button,[role="menuitem"],[role="menuitemradio"],[role="option"],[role="radio"]'))
                    .filter(option => visible(option) && this.optionIsSelected(option))
                    .map(option => parseEffortLevel(accessibleName(option)))
                    .filter(Boolean);
                const unique = Array.from(new Set(selected));
                return unique.length === 1 ? unique[0] : null;
            }

            async verifyManualChoice(level) {
                for (let attempt = 0; attempt < 30 && running; attempt += 1) {
                    const pending = this.manualPendingProvider();
                    if (!pending || pending.level !== level) return;
                    const current = this.inspect();
                    if (current.level === level || this.selectedMenuLevel() === level) {
                        this.setManualOverrideProvider(this.contextProvider());
                        state.statusMessage = `已确认你手动选择 ${level[0].toUpperCase()}${level.slice(1)}；当前对话会保留此设置。`;
                        this.publish();
                        return;
                    }
                    await delay(100);
                }
                if (this.manualPendingProvider()) {
                    this.setManualPendingProvider(null);
                    state.statusMessage = '未能确认刚才的 Effort 选择；发送保护会继续按当前可见状态处理。';
                    ui.render();
                    this.scan();
                }
            }

            async waitForMenu(control, maxMs) {
                const deadline = Date.now() + maxMs;
                while (running && Date.now() < deadline) {
                    const menus = this.menuRoots(control);
                    if (menus.length === 1) {
                        log('Effort 菜单可用', { elapsedMs: Math.round(monotonicNow() - scriptStartedAt) });
                        return menus[0];
                    }
                    await delay(100);
                }
                return null;
            }

            async revealEffortControl(maxMs) {
                let control = this.findControl();
                if (control) return { control, openedSettings: false, openedSection: false, activator: null, section: null };

                const activator = this.findEffortActivator();
                let openedSettings = false;
                if (activator && activator.getAttribute('aria-expanded') !== 'true') {
                    activator.click();
                    openedSettings = true;
                }

                let section = null;
                let openedSection = false;
                const deadline = Date.now() + maxMs;
                while (running && Date.now() < deadline) {
                    control = this.findControl();
                    if (control) return { control, openedSettings, openedSection, activator, section };

                    section = this.findEffortSectionToggle();
                    if (section && section.getAttribute('aria-expanded') !== 'true' && !openedSection) {
                        section.click();
                        openedSection = true;
                    }
                    await delay(100);
                }
                return { control: null, openedSettings, openedSection, activator, section };
            }

            async waitForLow(control, option, menu, maxMs) {
                const deadline = Date.now() + maxMs;
                while (running && Date.now() < deadline) {
                    const fresh = this.inspect();
                    if (fresh.level === 'low') return true;
                    if (menu && menu.isConnected) {
                        const currentOption = this.lowOption(menu);
                        if (currentOption && this.optionIsSelected(currentOption)) return true;
                    }
                    await delay(120);
                }
                return false;
            }

            async ensureLow(options) {
                const force = Boolean(options && options.force);
                const scheduledRetry = Boolean(options && options.scheduledRetry);
                if (this.busy) return { verified: false, reason: 'setting-in-progress' };
                this.busy = true;
                const context = this.contextProvider();
                const userChoiceVersion = this.userChoiceVersion;
                const stillCurrent = () => running && context === this.contextProvider() && userChoiceVersion === this.userChoiceVersion;
                let initial = this.inspect();
                let reveal = null;
                let openedByScript = false;
                let control = null;
                try {
                    if (initial.level === 'low') return { verified: true, reason: initial.cached ? 'recently-verified-low' : 'already-low' };
                    if (initial.kind === 'unsupported') return { verified: false, reason: 'unsupported' };

                    if (!initial.control && !force && !scheduledRetry && this.lastControlProbeContext === context && Date.now() - this.lastControlProbeAt < 6000) {
                        return { verified: false, reason: 'recent-failed-attempt' };
                    }
                    if (!initial.control && !force && !scheduledRetry) {
                        this.lastControlProbeContext = context;
                        this.lastControlProbeAt = Date.now();
                    }

                    reveal = initial.control
                        ? { control: initial.control, openedSettings: false, openedSection: false, activator: null, section: null }
                        : await this.revealEffortControl(force ? 1200 : 300);
                    if (!stillCurrent()) return { verified: false, reason: 'context-changed' };
                    control = reveal.control;
                    if (!control) return { verified: false, reason: 'control-unknown' };

                    initial = this.inspect();
                    if (initial.level === 'low') return { verified: true, reason: 'already-low' };
                    if (!force && this.manualOverrideProvider()) return { verified: false, reason: 'manual-override' };

                    const attemptKey = `${context}|${accessibleName(control)}|${initial.level || 'unknown'}`;
                    if (!force && !scheduledRetry && attemptKey === this.lastAttemptKey && Date.now() - this.lastAttemptAt < 5000) {
                        return { verified: false, reason: 'recent-failed-attempt' };
                    }
                    this.lastAttemptKey = attemptKey;
                    this.lastAttemptAt = Date.now();

                    if (control.tagName === 'SELECT') {
                        this.autoSelecting += 1;
                        let dispatched = false;
                        try {
                            dispatched = this.selectLow(control);
                        } finally {
                            this.autoSelecting -= 1;
                        }
                        if (!dispatched) return { verified: false, reason: 'low-option-not-identified' };
                        if (!stillCurrent()) return { verified: false, reason: 'context-changed' };
                        const verified = await this.waitForLow(control, null, null, 1600);
                        if (!stillCurrent()) return { verified: false, reason: 'context-changed' };
                        return { verified, reason: verified ? 'selected-and-verified' : 'selection-not-verifiable' };
                    }

                    let menu = this.menuRoots(control)[0] || null;
                    if (!menu) {
                        if (control.getAttribute('aria-expanded') !== 'true') {
                            control.click();
                            openedByScript = true;
                        }
                        menu = await this.waitForMenu(control, force ? 1200 : 800);
                    }
                    if (!stillCurrent()) return { verified: false, reason: 'context-changed' };
                    if (!menu) return { verified: false, reason: 'effort-menu-not-identified' };
                    const option = this.lowOption(menu);
                    if (!option) return { verified: false, reason: 'low-option-not-identified' };
                    if (this.optionIsSelected(option)) {
                        const verified = await this.waitForLow(control, option, menu, 800);
                        return { verified, reason: verified ? 'already-selected' : 'selection-not-verifiable' };
                    }
                    if (this.manualPendingProvider()) return { verified: false, reason: 'manual-choice-pending' };
                    this.autoSelecting += 1;
                    try {
                        option.click();
                    } finally {
                        this.autoSelecting -= 1;
                    }
                    if (!stillCurrent()) return { verified: false, reason: 'context-changed' };
                    const verified = await this.waitForLow(control, option, menu, 1600);
                    if (!stillCurrent()) return { verified: false, reason: 'context-changed' };
                    if (verified) log('Low 状态已验证', { elapsedMs: Math.round(monotonicNow() - scriptStartedAt) });
                    return { verified, reason: verified ? 'selected-and-verified' : 'selection-not-verifiable' };
                } catch (error) {
                    log('切换 Effort 失败', error);
                    return { verified: false, reason: 'interaction-error' };
                } finally {
                    if (openedByScript && control && control.isConnected && control.getAttribute('aria-expanded') === 'true') {
                        try { control.click(); } catch (_) { /* Leave the page usable if it rejects the close click. */ }
                    }
                    if (reveal && reveal.openedSection && reveal.section && reveal.section.isConnected && reveal.section.getAttribute('aria-expanded') === 'true') {
                        try { reveal.section.click(); } catch (_) { /* Restore the prior collapsed state when possible. */ }
                    }
                    if (reveal && reveal.openedSettings && reveal.activator && reveal.activator.isConnected && reveal.activator.getAttribute('aria-expanded') === 'true') {
                        try { reveal.activator.click(); } catch (_) { /* Restore the prior panel state when possible. */ }
                    }
                    this.busy = false;
                    this.publish();
                }
            }

            publish() {
                state.effortStatus = this.inspect();
                if (this.onState) this.onState(state.effortStatus);
                ui.render();
            }

            scheduleProbeRetry(context) {
                const delays = [250, 500, 1000, 2000];
                if (!running || context !== this.contextProvider() || this.retryTimer || this.retryCount >= delays.length) return;
                if (Date.now() - this.retryStartedAt >= 8000) return;
                const wait = Math.min(delays[this.retryCount], Math.max(0, 8000 - (Date.now() - this.retryStartedAt)));
                this.retryCount += 1;
                this.retryTimer = timeout(() => {
                    this.retryTimer = null;
                    if (context === this.contextProvider()) this.scan(true);
                }, wait);
            }

            async scan(scheduledRetry) {
                if (this.scanPromise) {
                    this.scanRequested = true;
                    return this.scanPromise;
                }
                const operation = this.performScan(Boolean(scheduledRetry));
                this.scanPromise = operation;
                try {
                    return await operation;
                } finally {
                    if (this.scanPromise === operation) this.scanPromise = null;
                    if (this.scanRequested && running) {
                        this.scanRequested = false;
                        timeout(() => this.scan(), 0);
                    }
                }
            }

            async performScan(scheduledRetry) {
                const context = this.contextProvider();
                log('Effort 扫描开始', { elapsedMs: Math.round(monotonicNow() - scriptStartedAt), scheduledRetry });
                if (this.retryContext !== context) {
                    this.retryContext = context;
                    this.retryStartedAt = Date.now();
                    this.retryCount = 0;
                }
                const current = this.inspect();
                state.effortStatus = current;
                if (this.manualInteractionUntil > Date.now()) {
                    state.statusMessage = '正在等待你完成 Effort 手动选择；自动切换已暂缓。';
                    ui.render();
                    return;
                }
                if (current.kind === 'unsupported') {
                    state.statusMessage = '当前页面明确标记 Effort 不可用；积分监控仍独立运行。';
                    ui.render();
                    return;
                }
                if (this.manualOverrideProvider() && current.level && current.level !== 'low') {
                    current.label = `${current.level[0].toUpperCase()}${current.level.slice(1)}（手动）`;
                    state.effortStatus = current;
                    state.statusMessage = '保留了你在当前对话和模型中的手动 Effort 选择。';
                    ui.render();
                    return;
                }
                if (this.manualPendingProvider()) {
                    state.statusMessage = '正在确认刚才的手动 Effort 选择，暂不自动覆盖。';
                    ui.render();
                    return;
                }
                if (current.level === 'low') {
                    this.retryCount = 0;
                    current.label = 'Low（已确认）';
                    state.effortStatus = current;
                    state.statusMessage = 'Effort 已确认是 Low。';
                    ui.render();
                    return;
                }
                if (!current.control || !current.level) {
                    if (!state.settings.autoLow) {
                        state.statusMessage = '未能确认 Effort 控件或当前状态；脚本没有点击其他 Low 按钮。';
                        ui.render();
                        return;
                    }
                }
                if (!state.settings.autoLow) {
                    state.statusMessage = '自动 Low 已关闭；当前 Effort 状态仅作提示。';
                    ui.render();
                    return;
                }
                const result = await this.ensureLow({ force: false, scheduledRetry });
                if (context !== this.contextProvider()) return;
                const after = this.inspect();
                state.effortStatus = after;
                state.statusMessage = result.verified
                    ? '自动选择 Low，并已从页面状态确认。'
                    : '无法确认 Low 已生效；请在 Poe 页面手动核对。';
                ui.render();
                log('Effort 自动设置结果', result);
                if (result.verified) this.retryCount = 0;
                else if (result.reason !== 'manual-override' && result.reason !== 'context-changed') this.scheduleProbeRetry(context);
            }

            onUserSelection(event) {
                if (this.autoSelecting || !event || !event.target || !event.target.closest) return;
                const control = this.findControl();
                if (!control) return;
                const menus = this.menuRoots(control);
                const clickedMenuOption = menus.length === 1 && menus[0].contains(event.target);
                if (event.type === 'click' && !clickedMenuOption && (control === event.target || control.contains(event.target))) {
                    this.userChoiceVersion += 1;
                    this.manualInteractionUntil = Date.now() + 5000;
                    if (this.retryTimer) {
                        win.clearTimeout(this.retryTimer);
                        timeouts.delete(this.retryTimer);
                        this.retryTimer = null;
                    }
                    timeout(() => {
                        if (this.manualInteractionUntil && this.manualInteractionUntil <= Date.now()) {
                            this.manualInteractionUntil = 0;
                            this.scan();
                        }
                    }, 5100);
                    state.statusMessage = '检测到 Effort 手动操作；自动切换已暂缓。';
                    ui.render();
                    return;
                }
                if (event.type === 'change' && control.tagName === 'SELECT' && event.target === control) {
                    const level = this.levelInElement(control);
                    if (!level) return;
                    this.userChoiceVersion += 1;
                    this.manualInteractionUntil = 0;
                    if (this.retryTimer) {
                        win.clearTimeout(this.retryTimer);
                        timeouts.delete(this.retryTimer);
                        this.retryTimer = null;
                    }
                    this.setManualPendingProvider(null);
                    if (level === 'low') {
                        this.setManualOverrideProvider(null);
                        state.statusMessage = '已确认手动选择 Low。';
                    } else {
                        this.setManualOverrideProvider(this.contextProvider());
                        state.statusMessage = `已确认你手动选择 ${level[0].toUpperCase()}${level.slice(1)}；当前对话会保留此设置。`;
                    }
                    this.publish();
                    return;
                }
                if (menus.length !== 1 || !menus[0].contains(event.target)) return;
                const option = event.target.closest('button,[role="menuitem"],[role="menuitemradio"],[role="option"],[role="radio"]');
                if (!option || !menus[0].contains(option)) return;
                const level = parseEffortLevel(accessibleName(option));
                if (!level) return;
                this.userChoiceVersion += 1;
                this.manualInteractionUntil = 0;
                if (this.retryTimer) {
                    win.clearTimeout(this.retryTimer);
                    timeouts.delete(this.retryTimer);
                    this.retryTimer = null;
                }
                if (level === 'low') {
                    this.setManualOverrideProvider(null);
                } else {
                    this.setManualPendingProvider({ level, context: this.contextProvider() });
                    state.statusMessage = `正在确认你手动选择的 ${level[0].toUpperCase()}${level.slice(1)}。`;
                    this.verifyManualChoice(level);
                }
                this.publish();
            }
        }

        const effortManager = new EffortManager();

        class TurnTracker {
            constructor() {
                this.tailKey = '';
                this.scheduled = false;
                this.lastSendAt = 0;
                this.sendVersion = 0;
            }

            tail() {
                // The message IDs and completion flags were checked on the live
                // Poe page. aria-live regions include unrelated route announcers.
                const elements = doc.querySelectorAll('[id^="message-"][data-complete]');
                for (let index = elements.length - 1; index >= 0; index -= 1) {
                    const element = elements[index];
                    const id = element.id.replace(/^message-/, '');
                    if (/^\d+$/.test(id) && visible(element)) {
                        return { id, complete: element.getAttribute('data-complete') === 'true' };
                    }
                }
                return null;
            }

            noteSend() {
                const now = Date.now();
                if (now - this.lastSendAt < 700) return;
                this.lastSendAt = now;
                const version = ++this.sendVersion;
                const route = win.location.href;
                const before = this.tailKey;
                pointsService.markRoundPending(null);
                // Do not redisplay the previous reply's cost while a send is
                // waiting for Poe. A failed send is not a zero-cost reply.
                timeout(() => {
                    if (version === this.sendVersion && win.location.href === route && this.tailKey === before) {
                        state.roundUsage = { points: null, status: 'unknown' };
                        ui.render();
                    }
                }, 120000);
            }

            observe() {
                if (!pointsService.chatId()) return;
                const tail = this.tail();
                if (!tail) return;
                const key = `${tail.id}:${tail.complete ? '1' : '0'}`;
                if (key === this.tailKey) return;
                this.tailKey = key;
                if (!tail.complete) {
                    pointsService.markRoundPending(tail.id);
                    return;
                }
                // readChat verifies that this is a bot reply, and readMessage
                // verifies its chat and job before exposing the official cost.
                // A completed user message alone is never treated as billable.
                pointsService.refreshRound(tail.id);
                pointsService.updateNativePercent();
            }

            schedule() {
                if (this.scheduled) return;
                this.scheduled = true;
                timeout(() => {
                    this.scheduled = false;
                    this.observe();
                }, 150);
            }

            resetForRoute() {
                this.sendVersion += 1;
                const tail = this.tail();
                this.tailKey = tail ? `${tail.id}:${tail.complete ? '1' : '0'}` : '';
            }
        }

        const turnTracker = new TurnTracker();

        class LifecycleManager {
            constructor() {
                this.observer = null;
                this.route = win.location.href;
                this.model = '';
                this.lastScanAt = 0;
                this.savedManual = loadSavedManualContext();
                this.manualContext = null;
                this.pendingManual = null;
                this.started = false;
                this.onMutation = this.onMutation.bind(this);
                this.onNavigation = this.onNavigation.bind(this);
                this.onPageHide = this.onPageHide.bind(this);
                this.onPageShow = this.onPageShow.bind(this);
                this.onVisibilityChange = this.onVisibilityChange.bind(this);
                this.lastVisibleRefreshAt = 0;
                this.scanScheduler = createFixedCoalescer(
                    (callback, ms) => timeout(callback, ms),
                    clearTimeoutTracked,
                    () => {
                        if (!running) return;
                        this.lastScanAt = Date.now();
                        this.checkContext();
                        effortManager.scan();
                    },
                    100
                );
            }

            contextKey() {
                return `${this.route}::${this.model || 'model-unknown'}`;
            }

            isManualOverride() {
                return Boolean(this.manualContext && this.manualContext === this.contextKey());
            }

            setManualContext(value) {
                this.manualContext = value;
                this.pendingManual = null;
                saveManualContext(value);
            }

            setPendingManual(value) {
                this.pendingManual = value;
            }

            isManualPending() {
                return Boolean(this.pendingManual && this.pendingManual.context === this.contextKey());
            }

            resetContext(reason, routeChanged) {
                this.manualContext = null;
                this.pendingManual = null;
                this.savedManual = null;
                saveManualContext(null);
                effortManager.invalidateContextEvidence();
                if (routeChanged) {
                    turnTracker.resetForRoute();
                    pointsService.refreshUsage();
                    pointsService.refreshRound();
                }
                state.statusMessage = `${reason}，正在重新检测 Effort。`;
            }

            checkContext() {
                readingGuard.refresh();
                const currentRoute = win.location.href;
                if (currentRoute !== this.route) {
                    this.route = currentRoute;
                    this.model = '';
                    this.resetContext('Poe 页面已切换', true);
                    pointsService.refreshQuietly('route');
                    turnTracker.resetForRoute();
                }
                const fingerprint = effortManager.modelFingerprint();
                if (fingerprint && !this.model) {
                    const previousKey = this.contextKey();
                    this.model = fingerprint;
                    const key = this.contextKey();
                    if (this.pendingManual && this.pendingManual.context === previousKey) this.pendingManual.context = key;
                    if (this.manualContext === previousKey) {
                        this.manualContext = key;
                        saveManualContext(key);
                    } else if (this.savedManual === key) this.manualContext = key;
                    else if (this.savedManual && this.savedManual.startsWith(`${this.route}::`)) {
                        this.manualContext = null;
                        saveManualContext(null);
                    }
                    this.savedManual = null;
                } else if (fingerprint && this.model && fingerprint !== this.model) {
                    this.model = fingerprint;
                    this.resetContext('检测到模型切换');
                }
                effortManager.publish();
            }

            scheduleScan(immediate) {
                this.scanScheduler.request(Boolean(immediate));
            }

            onMutation(mutations) {
                let effortRelevant = false;
                let messageRelevant = false;
                let percentRelevant = false;
                for (const mutation of mutations) {
                    const target = mutation.target && (mutation.target.nodeType === 1 ? mutation.target : mutation.target.parentElement);
                    if (!target || !target.closest) continue;
                    if (mutationContainsMessages(mutation)) {
                        messageRelevant = true;
                        continue;
                    }
                    const changedText = mutation.type === 'characterData'
                        ? mutation.target.nodeValue
                        : Array.from(mutation.addedNodes || []).map(node => node.textContent || '').join(' ');
                    if (changedText && /剩余\s*\d{1,3}\s*%\s*(?:的)?\s*(?:积分|points?)/i.test(changedText)) percentRelevant = true;
                    if (!isIgnoredMutation(mutation)) effortRelevant = true;
                }
                if (percentRelevant) pointsService.updateNativePercent();
                if (effortRelevant) {
                    this.checkContext();
                    this.scheduleScan(false);
                }
                if (messageRelevant) turnTracker.schedule();
            }

            onNavigation() {
                this.checkContext();
                pointsService.updateNativePercent();
                this.scheduleScan(true);
            }

            start() {
                if (this.started) return;
                if (!doc.documentElement) return;
                this.started = true;
                this.observer = new win.MutationObserver(this.onMutation);
                this.observer.observe(doc.documentElement, { childList: true, subtree: true, characterData: true, attributes: true,
                    attributeFilter: ['aria-label', 'aria-expanded', 'aria-checked', 'aria-selected', 'aria-pressed', 'aria-controls', 'aria-labelledby', 'role', 'hidden', 'data-complete'] });
                win.addEventListener('popstate', this.onNavigation, true);
                win.addEventListener('hashchange', this.onNavigation, true);
                win.addEventListener('pagehide', this.onPageHide, true);
                win.addEventListener('pageshow', this.onPageShow, true);
                doc.addEventListener('visibilitychange', this.onVisibilityChange, true);
                interval(() => this.checkContext(), 1100);
                interval(() => pointsService.refreshQuietly('periodic'), 5 * 60 * 1000);
                this.checkContext();
                turnTracker.resetForRoute();
                pointsService.refreshRound();
                this.scheduleScan(true);
            }

            stop() {
                this.pause();
                win.removeEventListener('pagehide', this.onPageHide, true);
                win.removeEventListener('pageshow', this.onPageShow, true);
            }

            pause() {
                if (this.observer) this.observer.disconnect();
                this.observer = null;
                this.scanScheduler.cancel();
                win.removeEventListener('popstate', this.onNavigation, true);
                win.removeEventListener('hashchange', this.onNavigation, true);
                doc.removeEventListener('visibilitychange', this.onVisibilityChange, true);
                this.started = false;
            }

            onPageHide(event) {
                running = false;
                clearTimers();
                this.pause();
                sendGuard.remove();
                readingGuard.stop();
                doc.removeEventListener('click', manualEffortHandler, true);
                doc.removeEventListener('keydown', manualEffortHandler, true);
                doc.removeEventListener('change', manualEffortHandler, true);
                pointsService.abortRequests();
                if (!event || !event.persisted) {
                    sendGuard.remove();
                    win.removeEventListener('pagehide', this.onPageHide, true);
                    win.removeEventListener('pageshow', this.onPageShow, true);
                    if (win[INSTANCE_KEY] === app) delete win[INSTANCE_KEY];
                }
            }

            onPageShow() {
                if (running) return;
                running = true;
                this.start();
                sendGuard.install();
                if (state.settings.readingLock) readingGuard.start();
                doc.addEventListener('click', manualEffortHandler, true);
                doc.addEventListener('keydown', manualEffortHandler, true);
                doc.addEventListener('change', manualEffortHandler, true);
                pointsService.refreshQuietly('initial');
                effortManager.scan();
            }

            onVisibilityChange() {
                if (doc.visibilityState !== 'visible' || Date.now() - this.lastVisibleRefreshAt < 5000) return;
                this.lastVisibleRefreshAt = Date.now();
                this.checkContext();
                pointsService.updateNativePercent();
                if (!pointsService.roundReader.busy()) pointsService.refreshRound();
            }
        }

        const lifecycle = new LifecycleManager();
        effortManager.contextProvider = () => lifecycle.contextKey();
        effortManager.manualOverrideProvider = () => lifecycle.isManualOverride();
        effortManager.setManualOverrideProvider = value => lifecycle.setManualContext(value);
        effortManager.manualPendingProvider = () => lifecycle.isManualPending() ? lifecycle.pendingManual : null;
        effortManager.setManualPendingProvider = value => lifecycle.setPendingManual(value);

        function isComposerControl(button, composer) {
            if (!button || !composer) return false;
            const form = composer.closest('form');
            if (form) return form.contains(button);
            let ancestor = composer.parentElement;
            for (let depth = 0; ancestor && depth < 7; depth += 1, ancestor = ancestor.parentElement) {
                if (!ancestor.contains(button)) continue;
                const editors = ancestor.querySelectorAll('textarea,[contenteditable="true"],[role="textbox"]');
                const controls = ancestor.querySelectorAll('button,[role="button"]');
                if (editors.length === 1 && controls.length <= 8) return true;
            }
            return false;
        }

        function isSendButton(target) {
            if (!target || !target.closest) return null;
            const button = target.closest('button,[role="button"]');
            if (!button || !visible(button) || button.closest('[data-poe-effort-points-ui="root"]')) return null;
            if (!isComposerControl(button, findComposer())) return null;
            const name = accessibleName(button);
            return /\bsend\b|send message|submit message|发送|提交/i.test(name) ? button : null;
        }

        function findSendButton() {
            const composer = findComposer();
            const candidates = Array.from(doc.querySelectorAll('button,[role="button"]'))
                .filter(button => visible(button) && !button.disabled && button.getAttribute('aria-disabled') !== 'true' && !button.closest('[data-poe-effort-points-ui="root"]'))
                .filter(button => isComposerControl(button, composer))
                .filter(button => /\bsend\b|send message|submit message|发送|提交/i.test(accessibleName(button)));
            if (candidates.length === 1) return candidates[0];
            if (composer) {
                const form = composer.closest('form');
                const inside = candidates.filter(button => form ? form.contains(button) : false);
                if (inside.length === 1) return inside[0];
            }
            return null;
        }

        class SendGuard {
            constructor() {
                this.inFlight = false;
                this.replay = null;
                this.allowChainForm = null;
                this.allowChainUntil = 0;
                this.onClick = this.onClick.bind(this);
                this.onKeyDown = this.onKeyDown.bind(this);
                this.onSubmit = this.onSubmit.bind(this);
            }

            install() {
                doc.addEventListener('click', this.onClick, true);
                doc.addEventListener('keydown', this.onKeyDown, true);
                doc.addEventListener('submit', this.onSubmit, true);
            }

            remove() {
                doc.removeEventListener('click', this.onClick, true);
                doc.removeEventListener('keydown', this.onKeyDown, true);
                doc.removeEventListener('submit', this.onSubmit, true);
            }

            isReplay(kind, target) {
                return this.replay && this.replay.kind === kind && (!this.replay.target || this.replay.target === target);
            }

            onClick(event) {
                const button = isSendButton(event.target);
                if (!button) return;
                if (this.isReplay('click', button)) {
                    this.replay = null;
                    turnTracker.noteSend();
                    return;
                }
                this.handle(event, 'click', button);
            }

            onKeyDown(event) {
                const composer = findComposer();
                if (!composer || !composer.contains(event.target)) return;
                if (event.key !== 'Enter' || event.shiftKey || event.altKey || event.ctrlKey || event.metaKey || event.isComposing || event.keyCode === 229) return;
                this.handle(event, 'enter', event.target);
            }

            onSubmit(event) {
                if (!event.target || event.target.tagName !== 'FORM') return;
                const composer = findComposer();
                if (!composer || !event.target.contains(composer)) return;
                if (this.allowChainForm === event.target && Date.now() <= this.allowChainUntil) {
                    this.allowChainForm = null;
                    this.allowChainUntil = 0;
                    turnTracker.noteSend();
                    return;
                }
                if (this.isReplay('submit', event.target)) {
                    this.replay = null;
                    turnTracker.noteSend();
                    return;
                }
                this.handle(event, 'submit', event.target);
            }

            hold(event) {
                if (event.cancelable) event.preventDefault();
                event.stopPropagation();
                if (typeof event.stopImmediatePropagation === 'function') event.stopImmediatePropagation();
            }

            async handle(event, kind, target) {
                if (!state.settings.sendGuard) {
                    turnTracker.noteSend();
                    return;
                }
                if (this.inFlight) {
                    this.hold(event);
                    state.statusMessage = '正在确认 Effort；这次重复触发已拦住。确认后请再发送一次。';
                    ui.render();
                    return;
                }
                if (lifecycle.isManualPending()) {
                    this.hold(event);
                    state.statusMessage = '刚才的手动 Effort 选择还在确认；确认后请再次发送。';
                    ui.render();
                    return;
                }
                const effort = effortManager.inspect();
                const manual = lifecycle.isManualOverride();
                const decision = decideSend(effort, state.settings, manual);
                const guardContext = lifecycle.contextKey();
                const userChoiceVersion = effortManager.userChoiceVersion;
                const guardComposer = findComposer();
                const guardText = composerText(guardComposer);
                if (state.allowOnce && decision.action === 'block') {
                    state.allowOnce = false;
                    ui.showAllowOnce(false);
                    if (kind !== 'submit') {
                        const form = target && target.closest ? target.closest('form') : null;
                        if (form) {
                            this.allowChainForm = form;
                            this.allowChainUntil = Date.now() + 900;
                        }
                    }
                    state.statusMessage = '已按你的确认放行这一次发送。';
                    ui.render();
                    turnTracker.noteSend();
                    return;
                }
                if (decision.action === 'allow') {
                    if (state.allowOnce) state.allowOnce = false;
                    if (decision.reason === 'effort-unknown-warning') {
                        state.statusMessage = 'Effort 未确认；按当前设置放行。需要强制拦截时可开启严格保护。';
                        ui.render();
                    }
                    turnTracker.noteSend();
                    return;
                }
                if (!event.cancelable) {
                    state.statusMessage = 'Safari 未允许取消这次发送事件；保护无法可靠拦截，请先手动确认 Effort。';
                    ui.render();
                    return;
                }
                this.hold(event);
                this.inFlight = true;
                ui.showAllowOnce(false);
                if (decision.action === 'block') {
                    state.statusMessage = '严格保护已拦住发送：请先手动确认 Effort，或点“本次允许发送”。';
                    ui.showAllowOnce(true);
                    ui.render();
                    this.inFlight = false;
                    return;
                }
                state.statusMessage = '发送已暂缓，正在尝试 Low 并检查页面状态…';
                ui.render();
                const busyDeadline = Date.now() + 6000;
                while (effortManager.busy && running && Date.now() < busyDeadline) await delay(100);
                if (!running) {
                    this.inFlight = false;
                    return;
                }
                if (guardContext !== lifecycle.contextKey() || userChoiceVersion !== effortManager.userChoiceVersion ||
                    guardComposer !== findComposer() || guardText !== composerText(guardComposer)) {
                    this.inFlight = false;
                    state.statusMessage = '聊天、模型、输入或 Effort 选择已变化；为避免误发，本次操作已取消，请检查后重新发送。';
                    ui.render();
                    return;
                }
                const result = await effortManager.ensureLow({ force: true });
                this.inFlight = false;
                if (!running) return;
                if (result.verified && guardContext === lifecycle.contextKey() &&
                    userChoiceVersion === effortManager.userChoiceVersion && guardComposer === findComposer() &&
                    guardText === composerText(guardComposer)) {
                    state.statusMessage = 'Low 已确认。正在继续你刚才的发送操作…';
                    ui.render();
                    this.replaySend(kind, target);
                } else {
                    state.statusMessage = 'Low 未能确认，原发送已拦住；请在 Poe 页面手动选择并再次发送。';
                    ui.render();
                }
            }

            replaySend(kind, target) {
                if (kind === 'click' && target && target.isConnected) {
                    const button = target;
                    this.replay = { kind: 'click', target: button };
                    timeout(() => {
                        if (this.replay && this.replay.target === button) this.replay = null;
                    }, 1200);
                    try {
                        button.click();
                        return;
                    } catch (error) {
                        log('安全放行时点击发送按钮失败', error);
                    }
                }
                if (kind === 'submit' && target && target.tagName === 'FORM' && typeof target.requestSubmit === 'function') {
                    this.replay = { kind: 'submit', target };
                    timeout(() => {
                        if (this.replay && this.replay.target === target) this.replay = null;
                    }, 1200);
                    try {
                        target.requestSubmit();
                        return;
                    } catch (error) {
                        log('安全放行时提交表单失败', error);
                    }
                }
                state.statusMessage = kind === 'enter'
                    ? 'Low 已确认；为避免脚本擅自重发，请再按一次 Enter 或点击发送。'
                    : 'Low 已确认，但无法安全重放发送事件；请重新点击发送。';
                ui.render();
            }
        }

        const sendGuard = new SendGuard();

        function manualEffortHandler(event) {
            effortManager.onUserSelection(event);
        }

        const app = {
            state,
            ui,
            pointsService,
            effortManager,
            turnTracker,
            lifecycle,
            sendGuard,
            readingGuard,
            stop() {
                running = false;
                clearTimers();
                lifecycle.stop();
                sendGuard.remove();
                readingGuard.stop();
                doc.removeEventListener('click', manualEffortHandler, true);
                doc.removeEventListener('keydown', manualEffortHandler, true);
                doc.removeEventListener('change', manualEffortHandler, true);
                pointsService.abortRequests();
                ui.destroy();
                if (win[INSTANCE_KEY] === app) delete win[INSTANCE_KEY];
            }
        };
        win[INSTANCE_KEY] = app;

        (async () => {
            log('用户脚本已启动', { elapsedMs: 0 });
            const savedPromise = readSetting(SETTINGS_KEY, DEFAULT_SETTINGS);
            await waitForDocumentReady();
            if (!running) return;
            log('Poe DOM 已就绪', { elapsedMs: Math.round(monotonicNow() - scriptStartedAt) });
            ui.mount();
            const saved = await savedPromise;
            if (saved && typeof saved === 'object') {
                state.settings = {
                    autoLow: saved.autoLow !== false,
                    sendGuard: saved.sendGuard !== false,
                    strictGuard: saved.strictGuard === true,
                    readingLock: saved.readingLock !== false,
                    debug: saved.debug === true
                };
            }
            if (!running) return;
            ui.render();
            ui.setSettingsEnabled(true);
            ui.onSettingChange = async (key, value) => {
                if (key === 'readingLock') {
                    if (value) readingGuard.start();
                    else readingGuard.stop();
                }
                await saveSettings();
                if (key === 'autoLow' && value) lifecycle.scheduleScan();
                if (key === 'strictGuard' && !value) ui.showAllowOnce(false);
                state.statusMessage = `${key === 'autoLow' ? '自动 Low' : key === 'sendGuard' ? '发送保护' : key === 'strictGuard' ? '严格保护' : key === 'readingLock' ? '固定阅读位置' : '调试日志'}设置已保存。`;
                ui.render();
            };
            ui.onAllowOnce = () => {
                state.allowOnce = true;
                ui.showAllowOnce(false);
                state.statusMessage = '已准备本次放行；请再次发起发送以完成确认。';
                ui.render();
            };
            ui.onJumpToBottom = readingGuard.jumpToBottom;
            doc.addEventListener('click', manualEffortHandler, true);
            doc.addEventListener('keydown', manualEffortHandler, true);
            doc.addEventListener('change', manualEffortHandler, true);
            lifecycle.start();
            sendGuard.install();
            if (state.settings.readingLock) readingGuard.start();
            else readingGuard.stop();
            pointsService.updateNativePercent();
            effortManager.publish();
            pointsService.refreshQuietly('initial');
        })();

        return app;
    }

    return Object.freeze({
        normalizeText,
        parseEffortLevel,
        isEffortSelectOptions,
        isExplicitlyUnavailableEffort,
        parsePointsBalance,
        parseRemainingPercent,
        parseResetText,
        botFingerprintFromHref,
        chatIdFromHref,
        parseChatPageData,
        parseMessageCostData,
        createRoundCostReader,
        roundUsageText,
        isIgnoredMutation,
        mutationContainsMessages,
        effortDisplayName,
        createFixedCoalescer,
        createReadingPositionGuard,
        retryBounded,
        createSingleFlight,
        decideSend,
        start
    });
});
