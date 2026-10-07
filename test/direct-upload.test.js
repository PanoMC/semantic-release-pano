const test = require('node:test');
const assert = require('node:assert');
const http = require('node:http');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const crypto = require('node:crypto');
const { publish } = require('../index.js');

const BYTES = Buffer.from('PK-fake-jar-bytes-' + 'x'.repeat(5000));
const SHA = crypto.createHash('sha256').update(BYTES).digest('hex');

function readBody(req) {
    return new Promise((resolve) => {
        const chunks = [];
        req.on('data', (c) => chunks.push(c));
        req.on('end', () => resolve(Buffer.concat(chunks)));
    });
}

async function setup(handlers = {}) {
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
                        headers: { 'Content-Type': 'application/java-archive', 'x-amz-acl': 'private', 'Content-Length': String(BYTES.length) }
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
    const file = path.join(dir, 'plugin.jar');
    fs.writeFileSync(file, BYTES);
    const lines = [];
    const logger = { log: (m) => lines.push(m), error: (m) => lines.push(m) };
    const run = (extra = {}) => publish(
        { resourceId: 'RES', file, panoVersion: '1.0.0', panoUrl: `http://127.0.0.1:${server.address().port}`, ...extra },
        { env: { PANO_TOKEN: 'TOK' }, nextRelease: { version: '1.2.3', gitTag: 'v1.2.3', notes: 'n' }, logger }
    );
    const close = () => { server.close(); fs.rmSync(dir, { recursive: true, force: true }); };
    return { calls, run, lines, close };
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
