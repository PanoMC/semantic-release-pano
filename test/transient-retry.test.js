const test = require('node:test');
const assert = require('node:assert');
const { isTransientFailure, rateLimitWaitMs, withTransientRetry } = require('../index.js');

const logger = { log() {}, error() {} };
const httpError = (status, data) => Object.assign(new Error(`HTTP ${status}`), { response: { status, data } });

test('gateway answers and a missing backend are transient, API answers are final', () => {
    assert.equal(isTransientFailure(new Error('socket hang up')), true);
    assert.equal(isTransientFailure(httpError(502, '')), true);
    assert.equal(isTransientFailure(httpError(404, '404 page not found\n')), true);
    assert.equal(isTransientFailure(httpError(404, { error: 'NOT_FOUND' })), false);
    assert.equal(isTransientFailure(httpError(404, '<html><body><h1>Resource not found</h1></body></html>')), false);
    assert.equal(isTransientFailure(httpError(400, { error: 'BAD_TAG' })), false);
});

test('a transient failure is repeated until the publish goes through', async () => {
    let calls = 0;
    const result = await withTransientRetry(logger, async () => {
        if (++calls < 3) throw httpError(404, '404 page not found\n');
        return 'done';
    }, [1, 1, 1]);
    assert.equal(result, 'done');
    assert.equal(calls, 3);
});

test('a final failure is not repeated', async () => {
    let calls = 0;
    await assert.rejects(withTransientRetry(logger, async () => { calls++; throw httpError(403, { error: 'NO_PERMISSION' }); }, [1, 1]));
    assert.equal(calls, 1);
});

test('409 on a repeated publish means the lost attempt went through', async () => {
    let calls = 0;
    await withTransientRetry(logger, async () => { throw ++calls === 1 ? new Error('socket hang up') : httpError(409, { error: 'VERSION_EXISTS' }); }, [1, 1]);
    assert.equal(calls, 2);
});

test('409 on the first attempt stays an error', async () => {
    await assert.rejects(withTransientRetry(logger, async () => { throw httpError(409, { error: 'VERSION_EXISTS' }); }, [1]));
});

test('gives up after the last wait', async () => {
    let calls = 0;
    await assert.rejects(withTransientRetry(logger, async () => { calls++; throw httpError(503, ''); }, [1, 1]));
    assert.equal(calls, 3);
});

test('a short 429 retryAfter is waited out, a long one is not', () => {
    assert.equal(rateLimitWaitMs(httpError(429, { error: 'RATE_LIMITED', retryAfter: 1, reason: 'TOO_FAST' })), 2000);
    assert.equal(rateLimitWaitMs(httpError(429, { error: 'RATE_LIMITED', retryAfter: 1750, reason: 'UPLOAD_PENDING_LIMIT' })), null);
    assert.equal(rateLimitWaitMs(httpError(429, { error: 'RATE_LIMITED' })), null);
    assert.equal(rateLimitWaitMs(httpError(503, { retryAfter: 1 })), null);
});

test('a paced publish is repeated after the wait the store asked for', async () => {
    let calls = 0;
    const started = Date.now();
    const result = await withTransientRetry(logger, async () => {
        if (++calls === 1) throw httpError(429, { error: 'RATE_LIMITED', retryAfter: 0, reason: 'TOO_FAST' });
        return 'done';
    }, [60000]);
    assert.equal(result, 'done');
    assert.equal(calls, 2);
    assert.ok(Date.now() - started < 5000);
});
