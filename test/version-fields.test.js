const test = require('node:test');
const assert = require('node:assert');
const { buildVersionFields, buildGitHubAssetUrl } = require('../index.js');

const repo = 'https://github.com/PanoMC/pano-plugins.git';
const link = (gitTag, version) =>
    buildGitHubAssetUrl(repo, buildVersionFields({ version, gitTag, notes: '', panoVersion: '1.0.0' }).gitTag, 'x-1.jar');

test('monorepo git tag: store tag is v<version>, link keeps git tag', () => {
    const f = buildVersionFields({ version: '1.2.0', gitTag: 'stripe-v1.2.0', notes: 'n', panoVersion: '1.0.0' });
    assert.strictEqual(f.tag, 'v1.2.0');
    assert.strictEqual(f.title, 'v1.2.0');
    assert.ok(link('stripe-v1.2.0', '1.2.0').includes('/download/stripe-v1.2.0/'));
});

test('plain tag: output unchanged', () => {
    const f = buildVersionFields({ version: '1.2.0', gitTag: 'v1.2.0', notes: 'n', panoVersion: '1.0.0' });
    assert.deepStrictEqual(
        { title: f.title, changelog: f.changelog, tag: f.tag, panoVersion: f.panoVersion },
        { title: 'v1.2.0', changelog: 'n', tag: 'v1.2.0', panoVersion: '1.0.0' }
    );
    assert.ok(link('v1.2.0', '1.2.0').includes('/download/v1.2.0/'));
});

test('missing gitTag falls back to v<version>', () => {
    assert.strictEqual(buildVersionFields({ version: '2.0.0', notes: '', panoVersion: '1' }).gitTag, 'v2.0.0');
});

test('prerelease monorepo tag', () => {
    const f = buildVersionFields({ version: '1.2.0-dev.3', gitTag: 'stripe-v1.2.0-dev.3', notes: '', panoVersion: '1.0.0' });
    assert.strictEqual(f.tag, 'v1.2.0-dev.3');
});
