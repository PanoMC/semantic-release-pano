const test = require('node:test');
const assert = require('node:assert');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const { readApiLevel, readManifestAttribute } = require('../lib/api-level.js');
const { makeZip, jarWithLevel, themeZipWithLevel } = require('./zip-fixture.js');

async function levelOf(bytes) {
    const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'srp-lvl-'));
    const file = path.join(dir, 'a.bin');
    fs.writeFileSync(file, bytes);
    try { return await readApiLevel(file); } finally { fs.rmSync(dir, { recursive: true, force: true }); }
}

test('jar manifest api-level, any case, stored or deflated', async () => {
    assert.strictEqual(await levelOf(jarWithLevel(7)), 7);
    assert.strictEqual(await levelOf(makeZip({ 'META-INF/MANIFEST.MF': 'Manifest-Version: 1.0\nAPI-LEVEL: 2\n\n' }, { stored: true })), 2);
});

test('theme zip manifest.json apiLevel', async () => {
    assert.strictEqual(await levelOf(themeZipWithLevel(5)), 5);
});

test('absent, zero, non-numeric or unreadable levels are null', async () => {
    assert.strictEqual(await levelOf(jarWithLevel(null)), null);
    assert.strictEqual(await levelOf(jarWithLevel(0)), null);
    assert.strictEqual(await levelOf(jarWithLevel('abc')), null);
    assert.strictEqual(await levelOf(makeZip({ 'manifest.json': '{bad' })), null);
    assert.strictEqual(await levelOf(makeZip({ 'readme.txt': 'hi' })), null);
});

test('manifest attribute in a later section or a wrapped line', () => {
    assert.strictEqual(readManifestAttribute('Manifest-Version: 1.0\n\nName: x\nApi-Level: 9\n', 'api-level'), null);
    assert.strictEqual(readManifestAttribute('Long: aaa\n bbb\nApi-Level: 3\n', 'api-level'), '3');
});
