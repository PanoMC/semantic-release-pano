const test = require('node:test');
const assert = require('node:assert');
const http = require('node:http');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const crypto = require('node:crypto');
const { publish, verifyConditions } = require('../index.js');

const { jarWithLevel, themeZipWithLevel } = require('./zip-fixture.js');

const BYTES = jarWithLevel(1);
const SHA = crypto.createHash('sha256').update(BYTES).digest('hex');

function readBody(req) {
    return new Promise((resolve) => {
        const chunks = [];
        req.on('data', (c) => chunks.push(c));
        req.on('end', () => resolve(Buffer.concat(chunks)));
    });
}

async function setup(handlers = {}, bytes = BYTES, fileName = 'plugin.jar') {
    const calls = [];
    const server = http.createServer(async (req, res) => {
        const body = await readBody(req);
        calls.push({ method: req.method, url: req.url, headers: req.headers, body });
        const send = (status, json) => {
            res.writeHead(status, { 'content-type': 'application/json' });
            res.end(JSON.stringify(json));
        };
        const base = '/v1/resources/RES/versions';
        if (req.method === 'PUT' && req.url.startsWith('/storage/')) {
            return handlers.put ? handlers.put(req, res, body, send) : send(200, {});
        }
        if (req.method === 'POST' && req.url === `${base}/uploads`) {
            return handlers.ticket ? handlers.ticket(req, res, body, send) : send(200, {
                result: 'ok',
                data: {
                    uploadId: 'U1', versionId: 'V1', status: 'PENDING',
                    upload: {
                        method: 'PUT',
                        url: `http://127.0.0.1:${server.address().port}/storage/obj?sig=SECRET`,
                        headers: { 'Content-Type': 'application/java-archive', 'x-amz-acl': 'private', 'Content-Length': String(bytes.length) }
                    }
                }
            });
        }
        if (req.method === 'POST' && req.url === `${base}/uploads/U1/complete`) {
            return handlers.complete ? handlers.complete(req, res, body, send) : send(200, { result: 'ok', data: { id: 'V1', status: 'COMPLETED' } });
        }
        if (req.method === 'DELETE' && req.url === `${base}/uploads/U1`) return send(200, { result: 'ok', data: { status: 'ABORTED' } });
        if (req.method === 'POST' && req.url === base) return send(200, { result: 'ok' });
        send(500, { error: 'UNEXPECTED' });
    });
    await new Promise((r) => server.listen(0, '127.0.0.1', r));
    const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'srp-'));
    const file = path.join(dir, fileName);
    fs.writeFileSync(file, bytes);
    const lines = [];
    const logger = { log: (m) => lines.push(m), error: (m) => lines.push(m) };
    const run = (extra = {}) => publish(
        { resourceId: 'RES', file, panoVersion: '1.0.0', panoUrl: `http://127.0.0.1:${server.address().port}`, ...extra },
        { env: { PANO_TOKEN: 'TOK' }, nextRelease: { version: '1.2.3', gitTag: 'v1.2.3', notes: 'n' }, logger }
    );
    const close = () => { server.close(); fs.rmSync(dir, { recursive: true, force: true }); };
    return { calls, run, lines, close, file };
}

const find = (calls, method, url) => calls.filter((c) => c.method === method && c.url === url);

test('direct success: ticket body, signed headers, exact bytes, complete', async () => {
    const t = await setup();
    try {
        const r = await t.run();
        assert.ok(r);
        const ticket = JSON.parse(find(t.calls, 'POST', '/v1/resources/RES/versions/uploads')[0].body);
        assert.deepStrictEqual(ticket, { fileName: 'plugin.jar', size: BYTES.length, sha256: SHA, title: 'v1.2.3', changelog: 'n', tag: 'v1.2.3', panoVersion: '1.0.0' });
        const put = t.calls.find((c) => c.method === 'PUT');
        assert.strictEqual(put.headers['content-type'], 'application/java-archive');
        assert.strictEqual(put.headers['x-amz-acl'], 'private');
        assert.strictEqual(put.headers['content-length'], String(BYTES.length));
        assert.strictEqual(put.headers.authorization, undefined);
        assert.ok(put.body.equals(BYTES));
        assert.strictEqual(find(t.calls, 'POST', '/v1/resources/RES/versions/uploads/U1/complete').length, 1);
        assert.strictEqual(find(t.calls, 'POST', '/v1/resources/RES/versions').length, 0);
        const log = t.lines.join('\n');
        assert.match(log, /direct to storage/);
        assert.ok(!log.includes('SECRET') && !log.includes('TOK'));
    } finally { t.close(); }
});

test('fallback to body upload on 404', async () => {
    const t = await setup({ ticket: (q, s, b, send) => send(404, { error: 'NOT_EXISTS' }) });
    try {
        await t.run();
        assert.strictEqual(find(t.calls, 'POST', '/v1/resources/RES/versions').length, 1);
        assert.strictEqual(t.calls.filter((c) => c.method === 'PUT').length, 0);
        assert.match(t.lines.join('\n'), /multipart body/);
    } finally { t.close(); }
});

test('fallback to body upload on 501 DIRECT_UPLOAD_UNAVAILABLE', async () => {
    const t = await setup({ ticket: (q, s, b, send) => send(501, { result: 'error', error: 'DIRECT_UPLOAD_UNAVAILABLE', reason: 'NOT_CONFIGURED' }) });
    try {
        await t.run();
        assert.strictEqual(find(t.calls, 'POST', '/v1/resources/RES/versions').length, 1);
    } finally { t.close(); }
});

test('no fallback on a real refusal (409, 403, 501 with other code)', async () => {
    for (const [status, body] of [[409, { error: 'TAG_ALREADY_EXISTS' }], [403, { error: 'NO_PERMISSION' }], [501, { error: 'SOMETHING_ELSE' }]]) {
        const t = await setup({ ticket: (q, s, b, send) => send(status, body) });
        try {
            await assert.rejects(t.run(), /Pano API Error/);
            assert.strictEqual(find(t.calls, 'POST', '/v1/resources/RES/versions').length, 0);
        } finally { t.close(); }
    }
});

test('PUT failure aborts and fails, no body fallback', async () => {
    const t = await setup({ put: (q, res) => { res.writeHead(403); res.end('<Error>SignatureDoesNotMatch</Error>'); } });
    try {
        await assert.rejects(t.run(), /Storage upload failed/);
        assert.strictEqual(find(t.calls, 'DELETE', '/v1/resources/RES/versions/uploads/U1').length, 1);
        assert.strictEqual(find(t.calls, 'POST', '/v1/resources/RES/versions/uploads/U1/complete').length, 0);
        assert.strictEqual(find(t.calls, 'POST', '/v1/resources/RES/versions').length, 0);
        assert.ok(!t.lines.join('\n').includes('SECRET'));
    } finally { t.close(); }
});

test('complete failure aborts and fails', async () => {
    const t = await setup({ complete: (q, s, b, send) => send(422, { error: 'UPLOAD_HASH_MISMATCH' }) });
    try {
        await assert.rejects(t.run(), /UPLOAD_HASH_MISMATCH/);
        assert.strictEqual(find(t.calls, 'DELETE', '/v1/resources/RES/versions/uploads/U1').length, 1);
        assert.strictEqual(find(t.calls, 'POST', '/v1/resources/RES/versions').length, 0);
    } finally { t.close(); }
});

test('complete 202 COMPLETING is polled until done', async () => {
    let n = 0;
    const t = await setup({ complete: (q, s, b, send) => (++n < 2 ? send(202, { data: { status: 'COMPLETING', retryAfter: 0 } }) : send(200, { data: { id: 'V1', status: 'COMPLETED' } })) });
    try {
        await t.run();
        assert.strictEqual(find(t.calls, 'POST', '/v1/resources/RES/versions/uploads/U1/complete').length, 2);
    } finally { t.close(); }
});

test('link mode does not touch the direct flow', async () => {
    const t = await setup();
    try {
        await t.run({ useGitHubLink: true, repositoryUrl: 'https://github.com/PanoMC/x.git' });
        assert.strictEqual(find(t.calls, 'POST', '/v1/resources/RES/versions/uploads').length, 0);
        const post = find(t.calls, 'POST', '/v1/resources/RES/versions')[0];
        assert.match(post.body.toString(), /releases\/download\/v1\.2\.3\/plugin\.jar/);
    } finally { t.close(); }
});

const formField = (body, name) => {
    const m = body.toString().match(new RegExp(`name="${name}"\\r\\n\\r\\n([^\\r]*)`));
    return m ? m[1] : null;
};

test('api level from a theme zip manifest.json goes into the ticket', async () => {
    const zip = themeZipWithLevel(3);
    const t = await setup({}, zip, 'theme.zip');
    try {
        await t.run({ sendApiLevel: true });
        const ticket = JSON.parse(find(t.calls, 'POST', '/v1/resources/RES/versions/uploads')[0].body);
        assert.strictEqual(ticket.apiLevel, 3);
        assert.strictEqual(ticket.fileName, 'theme.zip');
    } finally { t.close(); }
});

test('api level goes into the multipart fallback form', async () => {
    const t = await setup({ ticket: (q, s, b, send) => send(404, { error: 'NOT_EXISTS' }) });
    try {
        await t.run({ sendApiLevel: true });
        assert.strictEqual(formField(find(t.calls, 'POST', '/v1/resources/RES/versions')[0].body, 'apiLevel'), '1');
    } finally { t.close(); }
});

test('api level goes into the GitHub link form', async () => {
    const t = await setup({}, jarWithLevel(2));
    try {
        await t.run({ useGitHubLink: true, sendApiLevel: true, repositoryUrl: 'https://github.com/PanoMC/x.git' });
        assert.strictEqual(formField(find(t.calls, 'POST', '/v1/resources/RES/versions')[0].body, 'apiLevel'), '2');
    } finally { t.close(); }
});

test('without sendApiLevel the level is still required but not sent', async () => {
    const t = await setup({}, themeZipWithLevel(3), 'theme.zip');
    try {
        await t.run();
        assert.strictEqual('apiLevel' in JSON.parse(find(t.calls, 'POST', '/v1/resources/RES/versions/uploads')[0].body), false);
    } finally { t.close(); }
});

test('artifact without api-level: nothing is sent, message tells how to fix it', async () => {
    for (const bytes of [jarWithLevel(null), themeZipWithLevel(null), Buffer.from('not a zip')]) {
        const t = await setup({}, bytes);
        try {
            await assert.rejects(t.run(), /artifact has no api-level: run "bunx @panomc\/sdk pano-api migrate-v1" and rebuild/);
            assert.strictEqual(t.calls.length, 0);
        } finally { t.close(); }
    }
});

test('verifyConditions fails early on a built artifact without api-level, passes with one', async () => {
    const base = (file) => ({ resourceId: 'RES', file, panoVersion: '1.0.0' });
    const ctx = { env: { PANO_TOKEN: 'TOK' }, logger: { log() {}, error() {} } };
    const bad = await setup({}, jarWithLevel(null));
    const good = await setup({}, jarWithLevel(1));
    try {
        await assert.rejects(verifyConditions(base(bad.file), ctx), (e) => e.errors.some((x) => /artifact has no api-level/.test(x.message)));
        await verifyConditions(base(good.file), ctx);
        await verifyConditions(base(path.join(os.tmpdir(), 'not-built-yet-${version}.jar')), ctx);
    } finally { bad.close(); good.close(); }
});

test('apiLevel option overrides the artifact; requireApiLevel false lets a bare artifact through', async () => {
    const a = await setup({}, jarWithLevel(null));
    try {
        await a.run({ apiLevel: 4, sendApiLevel: true });
        assert.strictEqual(JSON.parse(find(a.calls, 'POST', '/v1/resources/RES/versions/uploads')[0].body).apiLevel, 4);
    } finally { a.close(); }
    const b = await setup({}, jarWithLevel(null));
    try {
        await b.run({ requireApiLevel: false });
        assert.strictEqual('apiLevel' in JSON.parse(find(b.calls, 'POST', '/v1/resources/RES/versions/uploads')[0].body), false);
    } finally { b.close(); }
});

// Keep last: it makes the plugin skip direct upload for the rest of the process (noTicketUntil).
test('fallback to body upload when the account has no free ticket (429 UPLOAD_PENDING_LIMIT)', async () => {
    const t = await setup({ ticket: (q, s, b, send) => send(429, { result: 'error', error: 'RATE_LIMITED', retryAfter: 1750, reason: 'UPLOAD_PENDING_LIMIT' }) });
    try {
        await t.run();
        assert.strictEqual(find(t.calls, 'POST', '/v1/resources/RES/versions').length, 1);
        assert.strictEqual(t.calls.filter((c) => c.method === 'PUT').length, 0);
    } finally { t.close(); }
});
