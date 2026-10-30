'use strict';

const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const vm = require('node:vm');
const {
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
    retryBounded,
    createSingleFlight,
    decideSend
} = require('../Poe_Effort_Points.user.js');

test('Effort level parser accepts a single explicit level', () => {
    assert.equal(parseEffortLevel('Reasoning Effort: Low'), 'low');
    assert.equal(parseEffortLevel('High (manual)'), 'high');
    assert.equal(parseEffortLevel('XHigh'), 'xhigh');
    assert.equal(parseEffortLevel('Max'), 'max');
    assert.equal(parseEffortLevel('中等强度'), 'medium');
    assert.equal(parseEffortLevel('Output Effort: None'), 'none');
});

test('Effort level parser rejects ambiguous or unrelated text', () => {
    assert.equal(parseEffortLevel('Low or High'), null);
    assert.equal(parseEffortLevel('Settings'), null);
    assert.equal(parseEffortLevel(''), null);
});

test('Effort select discovery requires explicit matching values and labels including Low', () => {
    assert.equal(isEffortSelectOptions([
        { value: 'max', text: 'Max' },
        { value: 'high', text: 'High' },
        { value: 'medium', text: 'Medium' },
        { value: 'low', text: 'Low' },
        { value: 'xhigh', text: 'XHigh' },
        { value: 'none', text: 'None' }
    ]), true);
    assert.equal(isEffortSelectOptions([
        { value: 'high', text: 'High' },
        { value: 'low', text: 'Low' }
    ]), true);
    assert.equal(isEffortSelectOptions([
        { value: 'high', text: 'High' },
        { value: 'low', text: 'High' }
    ]), false);
    assert.equal(isEffortSelectOptions([
        { value: 'low', text: 'Low' }
    ]), false);
    assert.equal(isEffortSelectOptions([
        { value: 'fast', text: 'Fast' },
        { value: 'deep', text: 'Deep' }
    ]), false);
    assert.equal(isEffortSelectOptions([
        { value: 'low', text: 'Low' },
        { value: 'medium', text: 'Medium' },
        { value: 'adaptive', text: 'Adaptive' }
    ]), true);
    assert.equal(isEffortSelectOptions([
        { value: 'low', text: 'High' },
        { value: 'medium', text: 'Medium' },
        { value: 'adaptive', text: 'Adaptive' }
    ]), false);
    assert.equal(isEffortSelectOptions([
        { value: 'low', text: 'Low' },
        { value: 'LOW', text: 'Low' }
    ]), false);
});

test('explicit unsupported Effort needs a disabled, Effort-specific control', () => {
    assert.equal(isExplicitlyUnavailableEffort('Output Effort unavailable', true), true);
    assert.equal(isExplicitlyUnavailableEffort('推理强度不支持', true), true);
    assert.equal(isExplicitlyUnavailableEffort('GPT-4o', true), false);
    assert.equal(isExplicitlyUnavailableEffort('Effort unavailable', false), false);
});

test('points parser reads labelled balances and accepts zero', () => {
    assert.equal(parsePointsBalance('Compute Points: 12,345'), 12345);
    assert.equal(parsePointsBalance('剩余积分：0'), 0);
    assert.equal(parsePointsBalance('Compute Points\n1,234\nReset in 4 hours'), 1234);
    assert.equal(parsePointsBalance('Current Points reset in 4 hours'), null);
    assert.equal(parsePointsBalance('积分\n1,447\n可用'), 1447);
});

test('remaining percent parser accepts Poe native wording without inventing values', () => {
    assert.equal(parseRemainingPercent('剩余14%积分。 查看详情'), 14);
    assert.equal(parseRemainingPercent('剩余 0% 的积分'), 0);
    assert.equal(parseRemainingPercent('14% of the points remaining'), 14);
    assert.equal(parseRemainingPercent('本次消耗 14%'), null);
    assert.equal(parseRemainingPercent('剩余 101% 积分'), null);
    assert.equal(parseRemainingPercent(''), null);
});

test('points parser does not mistake reset time or unrelated numbers for a balance', () => {
    assert.equal(parsePointsBalance('Compute Points\nPoints reset in 4 hours'), null);
    assert.equal(parsePointsBalance('Message cost: 30 points'), null);
    assert.equal(parsePointsBalance(''), null);
});

test('reset parser reports the reset line when present', () => {
    assert.equal(parseResetText('Compute Points\n1,000\nPoints reset in 5 hours'), 'Points reset in 5 hours');
    assert.equal(parseResetText('没有重置信息'), '没有重置信息');
    assert.equal(parseResetText('Compute Points\n1,000'), null);
});

test('Poe bot links provide a stable model fingerprint for same-URL model changes', () => {
    assert.equal(botFingerprintFromHref('https://poe.com/?bot=Claude-Opus-4.6'), 'bot:claude-opus-4.6');
    assert.equal(botFingerprintFromHref('/?bot=Claude-Sonnet-4.6', 'https://poe.com/chat/example'), 'bot:claude-sonnet-4.6');
    assert.equal(botFingerprintFromHref('https://poe.com/chat/example'), null);
});

test('chat identities use Poe chat IDs and do not merge same-titled chats', () => {
    assert.equal(chatIdFromHref('https://poe.com/chat/chat-abc'), 'chat-abc');
    assert.equal(chatIdFromHref('/chat/chat-def?source=history', 'https://poe.com/'), 'chat-def');
    assert.equal(chatIdFromHref('https://poe.com/Claude-Fable-5.1'), null);
});

// Minimal, anonymized versions of the server-rendered Poe fields observed on
// 2026-10-30. No message text, profile data, credentials, or request headers.
function chatData(code = 'chat-a', messages = [
    { messageId: 101, messageCode: 'user-code', authorUser: {}, bot: null, state: 'complete' },
    { messageId: 102, messageCode: 'bot-code', authorUser: null, bot: {}, state: 'complete', responsibleJob: { jobId: 900 } }
], complete = false) {
    return { props: { pageProps: { data: { mainQuery: { chatOfCode: {
        chatId: code === 'chat-a' ? 1 : 2,
        chatCode: code,
        messagesConnection: { edges: messages.map(node => ({ node })), pageInfo: { hasPreviousPage: !complete } }
    } } } } } };
}

function costData(points = 220, { state = 'completed', id = 102, code = 'bot-code', chatId = 1, jobId = 900 } = {}) {
    return { query: { message: code }, props: { pageProps: { data: { mainQuery: { messageOfCode: {
        messageId: id,
        chat: { chatId },
        state: 'complete',
        responsibleJob: {
            jobId, state, totalCostPoints: points,
            createdMessagesConnection: { edges: [{ node: { messageId: id, chat: { chatId } } }] }
        }
    } } } } } };
}

const reply = { id: '102', code: 'bot-code' };

test('official chat parser uses chat identity, message codes and bot roles without reading the sidebar', () => {
    const parsed = parseChatPageData(chatData(), 'chat-a');
    assert.equal(parsed.chatId, 1);
    assert.deepEqual(parsed.messages.map(m => m.bot), [false, true]);
    assert.equal(parsed.messages.at(-1).code, 'bot-code');
    assert.equal(parsed.historyComplete, false);
    assert.throws(() => parseChatPageData(chatData('same-title-other-chat'), 'chat-a'), /不匹配/);
    assert.throws(() => parseChatPageData({ props: { pageProps: { data: { leftNavigationSidebarQuery: {} } } } }, 'chat-a'));
});

test('message fee uses the official job total and distinguishes zero, missing and unsettled cost', () => {
    assert.equal(parseMessageCostData(costData(220), 1, reply).points, 220);
    assert.equal(parseMessageCostData(costData(0), 1, reply).status, 'settled');
    assert.equal(parseMessageCostData(costData(0), 1, reply).points, 0);
    assert.equal(parseMessageCostData(costData(null), 1, reply).status, 'pending');
    assert.equal(parseMessageCostData(costData(220, { state: 'running' }), 1, reply).points, null);
    assert.throws(() => parseMessageCostData(costData(220, { chatId: 2 }), 1, reply), /不匹配/);
    assert.throws(() => parseMessageCostData(costData(220, { code: 'other-code' }), 1, reply), /不匹配/);
    assert.throws(() => parseMessageCostData(costData(220, { id: 101 }), 1, reply), /不匹配/);
    const wrongJob = costData();
    wrongJob.props.pageProps.data.mainQuery.messageOfCode.responsibleJob.createdMessagesConnection.edges = [];
    assert.throws(() => parseMessageCostData(wrongJob, 1, reply), /属于当前回复/);
});

function readerHarness(overrides = {}) {
    let now = 0;
    const updates = [];
    const waits = [];
    let detailCalls = 0;
    const reader = createRoundCostReader({
        readChat: async code => parseChatPageData(chatData(code), code),
        readMessage: async (message, chatId) => {
            detailCalls += 1;
            return parseMessageCostData(costData(220, { id: Number(message.id), code: message.code, chatId }), chatId, message);
        },
        wait: async ms => { now += ms; waits.push(now); },
        now: () => now,
        onUpdate: update => updates.push(update),
        ...overrides
    });
    return { reader, updates, waits, detailCalls: () => detailCalls };
}

test('existing chats show the latest single round, replace it on the next reply, and deduplicate repeat reads', async () => {
    let data = chatData();
    let points = 220;
    let calls = 0;
    const h = readerHarness({
        readChat: async code => parseChatPageData(data, code),
        readMessage: async (message, chatId) => {
            calls += 1;
            return parseMessageCostData(costData(points, { id: Number(message.id), code: message.code, chatId }), chatId, message);
        }
    });
    const first = h.reader.start('chat-a');
    assert.strictEqual(h.reader.start('chat-a'), first);
    await first;
    assert.equal(h.updates.at(-1).points, 220);
    await h.reader.start('chat-a', '102');
    assert.equal(calls, 1);
    data = chatData('chat-a', [
        { messageId: 103, messageCode: 'user-2', authorUser: {}, state: 'complete' },
        { messageId: 104, messageCode: 'reply-2', authorUser: null, bot: {}, state: 'complete' }
    ]);
    points = 50;
    await h.reader.start('chat-a', '104');
    assert.equal(h.updates.at(-1).points, 50); // Never 220 + 50.
    assert.equal(h.updates.at(-1).messageId, '104');
    assert.equal(calls, 2);
});

test('an empty new chat waits for a send; an incomplete history or user message never becomes a false zero', async () => {
    const empty = readerHarness({ readChat: async code => parseChatPageData(chatData(code, [], true), code) });
    await empty.reader.start('chat-a');
    assert.equal(empty.updates.at(-1).status, 'idle');
    assert.equal(empty.updates.at(-1).points, null);
    const partial = readerHarness({ readChat: async code => parseChatPageData(chatData(code, [], false), code) });
    await partial.reader.start('chat-a');
    assert.equal(partial.updates.at(-1).status, 'unknown');
    const userOnly = readerHarness({ readChat: async code => parseChatPageData(chatData(code, [
        { messageId: 103, messageCode: 'user-code', authorUser: {}, state: 'complete' }
    ]), code) });
    await userOnly.reader.start('chat-a', '103');
    assert.equal(userOnly.detailCalls(), 0);
    assert.equal(userOnly.updates.at(-1).status, 'pending');
});

test('settlement retries at bounded times and never displays the previous reply while the server is late', async () => {
    let attempts = 0;
    const h = readerHarness({
        readChat: async code => parseChatPageData(chatData(code, ++attempts < 3 ? [
            { messageId: 100, messageCode: 'old-reply', authorUser: null, bot: {}, state: 'complete' }
        ] : undefined), code)
    });
    await h.reader.start('chat-a', '102');
    assert.deepEqual(h.waits, [2000, 5000]);
    assert.equal(h.detailCalls(), 1);
    assert.equal(h.updates.at(-1).points, 220);
    assert.ok(h.updates.every(u => u.points === null || u.messageId === '102'));
    let settlementAttempts = 0;
    const delayed = readerHarness({ readMessage: async () => ({
        status: ++settlementAttempts < 3 ? 'pending' : 'settled',
        points: settlementAttempts < 3 ? null : 0,
        messageId: '102', jobId: '900'
    }) });
    await delayed.reader.start('chat-a');
    assert.deepEqual(delayed.waits, [2000, 5000]);
    assert.equal(roundUsageText(delayed.updates.at(-1)), '0 积分');
});

test('failed fee reads stop, expose unknown, and do not invent a zero', async () => {
    let calls = 0;
    const h = readerHarness({ readChat: async () => { calls += 1; throw new Error('offline'); } });
    await h.reader.start('chat-a');
    assert.equal(calls, 5);
    assert.deepEqual(h.waits, [2000, 5000, 10000, 20000]);
    assert.equal(h.updates.at(-1).status, 'unknown');
    assert.equal(h.updates.at(-1).points, null);
    assert.equal(h.updates.at(-1).retryStopped, true);
    assert.equal(roundUsageText(h.updates.at(-1)), '未知');
    assert.equal(h.reader.busy(), false);
});

test('a chat switch cancels an old request even when that request ignores abort', async () => {
    let release;
    let oldSignal;
    const h = readerHarness({ readChat: (code, { signal }) => {
        if (code === 'chat-a') {
            oldSignal = signal;
            return new Promise(resolve => { release = resolve; });
        }
        return Promise.resolve(parseChatPageData(chatData(code), code));
    } });
    const old = h.reader.start('chat-a');
    const next = h.reader.start('chat-b');
    assert.equal(oldSignal.aborted, true);
    await next;
    const updateCount = h.updates.length;
    release(parseChatPageData(chatData(), 'chat-a'));
    await old;
    assert.equal(h.updates.length, updateCount);
    assert.equal(h.updates.at(-1).chatCode, 'chat-b');
    assert.equal(h.updates.at(-1).status, 'settled');
});

test('a regenerated job replaces a cached price even when the message ID stays the same', async () => {
    let jobId = 900;
    let points = 220;
    let detailCalls = 0;
    const h = readerHarness({
        readChat: async code => {
            const data = chatData(code);
            data.props.pageProps.data.mainQuery.chatOfCode.messagesConnection.edges[1].node.responsibleJob.jobId = jobId;
            return parseChatPageData(data, code);
        },
        readMessage: async (message, chatId) => {
            detailCalls += 1;
            return parseMessageCostData(costData(points, { jobId }), chatId, message);
        }
    });
    await h.reader.start('chat-a');
    jobId = 901;
    points = 15;
    await h.reader.start('chat-a');
    assert.equal(detailCalls, 2);
    assert.equal(h.updates.at(-1).points, 15);
});

// Exercise the actual PointsService -> GM request -> page-data parsers -> UI
// state path. This shell deliberately leaves DOMContentLoaded pending; it does
// not claim to test a real DOM, Poe events, or the Safari extension itself.
function serviceHarness(apiStyle, { hold = false } = {}) {
    const requests = [];
    let aborts = 0;
    const request = options => {
        requests.push(options);
        if (hold) return { abort() { aborts += 1; } };
        const response = { status: 200, finalUrl: options.url, responseText: JSON.stringify(
            options.url.includes('/chat/') ? chatData() : costData()
        ) };
        if (apiStyle === 'modern') return Promise.resolve(response);
        queueMicrotask(() => options.onload(response));
        return { abort() { aborts += 1; } };
    };
    const sandbox = {
        module: { exports: {} }, URL, AbortController,
        ...(apiStyle === 'modern' ? { GM: { xmlHttpRequest: request } } : { GM_xmlhttpRequest: request })
    };
    vm.runInNewContext(fs.readFileSync(require.resolve('../Poe_Effort_Points.user.js'), 'utf8'), sandbox);
    const win = {
        document: { addEventListener() {}, removeEventListener() {} },
        location: { href: 'https://poe.com/chat/chat-a', origin: 'https://poe.com' },
        addEventListener() {}, removeEventListener() {},
        setTimeout, clearTimeout, setInterval, clearInterval, AbortController,
        DOMParser: class {
            parseFromString(html) { return { getElementById: () => ({ textContent: html }) }; }
        }
    };
    if (apiStyle === 'native') {
        win.fetch = async (url, options) => {
            requests.push({ url, ...options });
            return { status: 200, url, text: async () => JSON.stringify(url.includes('/chat/') ? chatData() : costData()) };
        };
    }
    const app = sandbox.module.exports.start(win);
    return { app, win, requests, aborts: () => aborts };
}

for (const apiStyle of ['legacy', 'modern', 'native']) {
    test(`PointsService reads official round fees end to end with ${apiStyle} GM requests`, async () => {
        const h = serviceHarness(apiStyle);
        try {
            await h.app.pointsService.refreshRound();
            assert.equal(h.app.state.roundUsage.status, 'settled');
            assert.equal(h.app.state.roundUsage.points, 220);
            assert.deepEqual(h.requests.map(r => r.url), [
                'https://poe.com/chat/chat-a', 'https://poe.com/message/bot-code'
            ]);
            assert.ok(h.requests.every(r => r.method === 'GET' && !r.data && !r.headers));
            if (apiStyle === 'native') {
                assert.ok(h.requests.every(r => r.credentials === 'same-origin' && r.cache === 'no-store'));
            }
            assert.equal(h.app.pointsService.requests.size, 0);
        } finally { h.app.stop(); }
    });
}

test('PointsService teardown aborts the outstanding page read without leaking requests', async () => {
    const h = serviceHarness('legacy', { hold: true });
    const pending = h.app.pointsService.refreshRound();
    assert.equal(h.app.pointsService.requests.size, 1);
    h.app.stop();
    await pending;
    assert.equal(h.aborts(), 1);
    assert.equal(h.app.pointsService.requests.size, 0);
});

test('TurnTracker ignores the initialized history, follows each new completion and suppresses repeated observations', () => {
    const h = serviceHarness('legacy');
    const messages = [];
    const entry = (id, complete) => ({
        id: `message-${id}`, isConnected: true,
        getAttribute(name) { return name === 'data-complete' ? String(complete) : null; }
    });
    h.win.document.querySelectorAll = selector => selector === '[id^="message-"][data-complete]' ? messages : [];
    const reads = [];
    h.app.pointsService.refreshRound = id => reads.push(id);
    try {
        messages.push(entry(101, true), entry(102, true));
        h.app.turnTracker.resetForRoute();
        h.app.turnTracker.observe();
        assert.deepEqual(reads, []); // History is handled by the initial official read.
        messages.push(entry(103, true));
        h.app.turnTracker.observe();
        messages.push(entry(104, false));
        h.app.turnTracker.observe();
        assert.equal(h.app.state.roundUsage.status, 'pending');
        messages[messages.length - 1] = entry(104, true);
        h.app.turnTracker.observe();
        h.app.turnTracker.observe();
        assert.deepEqual(reads, ['103', '104']);
        // A fresh chat has no initialized history. Its first reply must work too.
        messages.length = 0;
        h.app.turnTracker.resetForRoute();
        messages.push(entry(201, true), entry(202, true));
        h.app.turnTracker.observe();
        assert.equal(reads.at(-1), '202');
    } finally { h.app.stop(); }
});

test('message mutations are excluded from Effort rescans while user-facing Effort text stays concise', () => {
    const message = { id: 'message-1' };
    const target = {
        nodeType: 1,
        closest(selector) {
            return selector === '[id^="message-"]' ? message : null;
        }
    };
    const mutation = { type: 'attributes', target };
    assert.equal(mutationContainsMessages(mutation), true);
    assert.equal(isIgnoredMutation(mutation), true);
    assert.equal(effortDisplayName({ kind: 'supported', level: 'xhigh' }), 'XHigh');
    assert.equal(effortDisplayName({ kind: 'unsupported', level: null }), 'None');
    assert.equal(effortDisplayName({ kind: 'unknown', level: null }), 'None');
});

test('fixed-delay scan coalescing cannot be postponed by repeated mutations', () => {
    let now = 0;
    let nextId = 1;
    const jobs = new Map();
    const schedule = (callback, delay) => {
        const id = nextId++;
        jobs.set(id, { callback, at: now + delay });
        return id;
    };
    const cancel = id => jobs.delete(id);
    let scans = 0;
    const coalescer = createFixedCoalescer(schedule, cancel, () => { scans += 1; }, 100);
    const advance = ms => {
        now += ms;
        for (const [id, job] of [...jobs]) {
            if (job.at > now) continue;
            jobs.delete(id);
            job.callback();
        }
    };

    coalescer.request(false);
    advance(50);
    coalescer.request(false);
    advance(50);
    assert.equal(scans, 1);
    for (let tick = 0; tick < 8; tick += 1) {
        coalescer.request(false);
        advance(50);
        coalescer.request(false);
        advance(50);
    }
    assert.equal(scans, 9);
    coalescer.dispose();
    coalescer.request(true);
    advance(1);
    assert.equal(scans, 9);
});

test('failed operations stop after the configured retry limit', async () => {
    let calls = 0;
    let waits = 0;
    await assert.rejects(
        retryBounded(
            async () => {
                calls += 1;
                throw new Error(`failure ${calls}`);
            },
            3,
            async () => { waits += 1; }
        ),
        /failure 3/
    );
    assert.equal(calls, 3);
    assert.equal(waits, 2);
});

test('single-flight shares one in-progress request and permits the next request afterward', async () => {
    const runSingleFlight = createSingleFlight();
    let calls = 0;
    let release;
    const operation = () => {
        calls += 1;
        return new Promise(resolve => { release = resolve; });
    };
    const first = runSingleFlight(operation);
    const second = runSingleFlight(operation);
    assert.strictEqual(first, second);
    await Promise.resolve();
    assert.equal(calls, 1);
    release('ok');
    assert.equal(await first, 'ok');
    assert.equal(await runSingleFlight(async () => { calls += 1; return 'next'; }), 'next');
    assert.equal(calls, 2);
});

test('send decision allows verified Low, a manual high choice, and explicitly unsupported Effort', () => {
    const settings = { sendGuard: true, strictGuard: true };
    assert.equal(decideSend({ kind: 'supported', level: 'low' }, settings, false).action, 'allow');
    assert.equal(decideSend({ kind: 'supported', level: 'high' }, settings, true).reason, 'manual-choice');
    assert.equal(decideSend({ kind: 'supported', level: 'none' }, settings, true).reason, 'manual-choice');
    assert.equal(decideSend({ kind: 'unsupported', level: null }, settings, false).reason, 'unsupported');
});

test('send decision repairs unapproved high Effort and blocks an unknown state only in strict mode', () => {
    assert.equal(decideSend({ kind: 'supported', level: 'medium' }, { sendGuard: true }, false).action, 'set-low');
    assert.equal(decideSend({ kind: 'supported', level: 'none' }, { sendGuard: true }, false).action, 'set-low');
    assert.equal(decideSend({ kind: 'unknown', level: null }, { sendGuard: true, strictGuard: true }, false).action, 'block');
    assert.deepEqual(
        decideSend({ kind: 'unknown', level: null }, { sendGuard: true, strictGuard: false }, false),
        { action: 'allow', reason: 'effort-unknown-warning' }
    );
    assert.equal(decideSend({ kind: 'supported', level: 'high' }, { sendGuard: false }, false).reason, 'guard-off');
});
