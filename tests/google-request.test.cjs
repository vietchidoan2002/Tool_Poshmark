const { test } = require('node:test');
const assert = require('node:assert/strict');
const { createGoogleRequest } = require('../server/google-request.cjs');
const { processOrders } = require('../server/bot.cjs');

function clock(options = {}) {
    let t = 0; const waits = [];
    return { waits, request: createGoogleRequest({ now: () => t, wait: async ms => { waits.push(ms); t += ms; }, random: () => 0, ...options }) };
}
test('rate limits honor Retry-After and pace subsequent requests', async () => {
    const { waits, request } = clock(); let calls = 0;
    const result = await request(async options => {
        assert.equal(options.retry, false);
        if (++calls === 1) throw { response: { status: 429, headers: { 'retry-after': '8' } } };
        return 'ok';
    });
    assert.equal(result, 'ok'); await request(async () => 'next');
    assert.deepEqual(waits, [8000, 650]);
});
test('403 rate limits retry, permission errors fail immediately, retries are bounded', async () => {
    const { request } = clock(); let calls = 0;
    await assert.rejects(request(async () => { calls++; throw Object.assign(new Error('quota'), { response: { status: 403, data: { error: { errors: [{ reason: 'userRateLimitExceeded' }] } } } }); }), /quota/);
    assert.equal(calls, 4);
    const denied = new Error('permission'); denied.response = { status: 403 }; calls = 0;
    await assert.rejects(request(async () => { calls++; throw denied; }), /permission/); assert.equal(calls, 1);
});
test('retry does not overrun the API execution budget', async () => {
    const { request, waits } = clock({ budgetMs: 500 });
    await assert.rejects(request(async () => { throw Object.assign(new Error('quota'), { response: { status: 429 } }); }), /quota/);
    assert.deepEqual(waits, []);
});

function clients({ failModify = false, unrelated = false, duplicate = false } = {}) {
    let writes = 0, modifies = 0;
    const id = 'abcdef0123456789abcdef01';
    const gmail = { users: { messages: {
        list: async args => { assert.equal(args.maxResults, 25); return { data: { messages: [{ id: 'test' }] } }; },
        get: async () => ({ data: { payload: { headers: [], mimeType: 'text/plain', body: { data: Buffer.from(unrelated ? 'Newsletter' : `Order Number ${id} Size: M Buyer: @sample`).toString('base64') } } } }),
        modify: async () => { modifies++; if (failModify) throw new Error('quota exhausted'); return {}; }
    } } };
    const sheets = { spreadsheets: { values: {
        get: async () => ({ data: { values: duplicate ? [['id order'], [id.toUpperCase()]] : [['id order']] } }),
        batchUpdate: async () => { writes++; return {}; }
    } } };
    return { gmail, sheets, request: fn => fn({}), counts: () => ({ writes, modifies }) };
}
test('a Gmail failure after a Sheets write propagates accurate partial counts', async () => {
    const options = clients({ failModify: true });
    await assert.rejects(processOrders(null, 'Test', 'Orders', options), error => {
        assert.deepEqual(error.partialStats, { writtenCount: 1, skippedCount: 0 }); return true;
    });
    assert.deepEqual(options.counts(), { writes: 1, modifies: 1 });
});
test('rerunning after a partial write skips duplicate IDs regardless of case', async () => {
    const options = clients({ duplicate: true });
    assert.deepEqual(await processOrders(null, 'Test', 'Orders', options), { writtenCount: 0, skippedCount: 1 });
    assert.deepEqual(options.counts(), { writes: 0, modifies: 1 });
});
test('unrelated mail is not marked read', async () => {
    const options = clients({ unrelated: true });
    await processOrders(null, 'Test', 'Orders', options);
    assert.deepEqual(options.counts(), { writes: 0, modifies: 0 });
});
