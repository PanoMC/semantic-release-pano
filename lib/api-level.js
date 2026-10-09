const fs = require('fs-extra');
const zlib = require('zlib');

const MISSING_MESSAGE = 'artifact has no api-level: run "bunx @panomc/sdk pano-api migrate-v1" and rebuild';

/**
 * Read one entry of a zip file (jar or theme zip) without a zip dependency. Returns a Buffer, or null when the
 * archive has no such entry. Only the central directory is walked; the entry is stored or deflated.
 */
function readZipEntry(zip, wanted) {
    const minEnd = 22;
    let eocd = -1;
    for (let i = zip.length - minEnd; i >= Math.max(0, zip.length - minEnd - 0xffff); i--) {
        if (zip.readUInt32LE(i) === 0x06054b50) {
            eocd = i;
            break;
        }
    }
    if (eocd < 0) throw new Error('not a zip archive');

    const count = zip.readUInt16LE(eocd + 10);
    let pos = zip.readUInt32LE(eocd + 16);
    for (let n = 0; n < count; n++) {
        if (zip.readUInt32LE(pos) !== 0x02014b50) throw new Error('corrupt zip central directory');
        const method = zip.readUInt16LE(pos + 10);
        const compressedSize = zip.readUInt32LE(pos + 20);
        const nameLen = zip.readUInt16LE(pos + 28);
        const extraLen = zip.readUInt16LE(pos + 30);
        const commentLen = zip.readUInt16LE(pos + 32);
        const localOffset = zip.readUInt32LE(pos + 42);
        const name = zip.toString('utf8', pos + 46, pos + 46 + nameLen);
        pos += 46 + nameLen + extraLen + commentLen;
        if (name !== wanted) continue;

        const localNameLen = zip.readUInt16LE(localOffset + 26);
        const localExtraLen = zip.readUInt16LE(localOffset + 28);
        const start = localOffset + 30 + localNameLen + localExtraLen;
        const data = zip.subarray(start, start + compressedSize);
        if (method === 0) return Buffer.from(data);
        if (method === 8) return zlib.inflateRawSync(data);
        throw new Error(`unsupported zip compression method ${method}`);
    }
    return null;
}

/** Value of a main-section attribute of a jar manifest (names are case-insensitive, lines wrap with a leading space). */
function readManifestAttribute(manifestText, attribute) {
    const lines = manifestText.replace(/\r\n?/g, '\n').replace(/\n /g, '').split('\n');
    const wanted = attribute.toLowerCase();
    for (const line of lines) {
        if (line === '') break; // end of the main section
        const colon = line.indexOf(':');
        if (colon > 0 && line.slice(0, colon).trim().toLowerCase() === wanted) return line.slice(colon + 1).trim();
    }
    return null;
}

function toLevel(raw) {
    const n = typeof raw === 'string' ? (/^\d+$/.test(raw.trim()) ? Number(raw.trim()) : NaN) : raw;
    return Number.isInteger(n) && n >= 1 ? n : null;
}

/**
 * The API level an artifact needs: jar manifest attribute `api-level`, else `apiLevel` in the root `manifest.json`
 * (themes, custom apps). Returns null when the artifact does not carry one.
 */
async function readApiLevel(filePath) {
    const zip = await fs.readFile(filePath);
    const manifest = readZipEntry(zip, 'META-INF/MANIFEST.MF');
    if (manifest) {
        const level = toLevel(readManifestAttribute(manifest.toString('utf8'), 'api-level'));
        if (level !== null) return level;
    }
    const json = readZipEntry(zip, 'manifest.json');
    if (json) {
        try {
            const level = toLevel(JSON.parse(json.toString('utf8').replace(/^﻿/, '')).apiLevel);
            if (level !== null) return level;
        } catch (e) {
            // an unreadable manifest.json carries no level
        }
    }
    return null;
}

module.exports = { MISSING_MESSAGE, readApiLevel, readZipEntry, readManifestAttribute };
