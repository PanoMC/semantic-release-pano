// Builds small zip archives (jar / theme zip fixtures) in memory. Not a test file; node --test just loads it.
const zlib = require('node:zlib');

const CRC_TABLE = Array.from({ length: 256 }, (_, n) => {
    let c = n;
    for (let k = 0; k < 8; k++) c = c & 1 ? 0xedb88320 ^ (c >>> 1) : c >>> 1;
    return c >>> 0;
});

function crc32(buf) {
    let c = 0xffffffff;
    for (const b of buf) c = CRC_TABLE[(c ^ b) & 0xff] ^ (c >>> 8);
    return (c ^ 0xffffffff) >>> 0;
}

/** @param {Record<string, string|Buffer>} entries name -> content; names ending in a deflate flag are not needed, all are deflated except "stored/" ones */
function makeZip(entries, { stored = false } = {}) {
    const locals = [];
    const central = [];
    let offset = 0;
    for (const [name, content] of Object.entries(entries)) {
        const raw = Buffer.from(content);
        const data = stored ? raw : zlib.deflateRawSync(raw);
        const nameBuf = Buffer.from(name);
        const crc = crc32(raw);
        const method = stored ? 0 : 8;

        const local = Buffer.alloc(30);
        local.writeUInt32LE(0x04034b50, 0);
        local.writeUInt16LE(20, 4);
        local.writeUInt16LE(method, 8);
        local.writeUInt32LE(crc, 14);
        local.writeUInt32LE(data.length, 18);
        local.writeUInt32LE(raw.length, 22);
        local.writeUInt16LE(nameBuf.length, 26);
        locals.push(local, nameBuf, data);

        const cd = Buffer.alloc(46);
        cd.writeUInt32LE(0x02014b50, 0);
        cd.writeUInt16LE(20, 4);
        cd.writeUInt16LE(20, 6);
        cd.writeUInt16LE(method, 10);
        cd.writeUInt32LE(crc, 16);
        cd.writeUInt32LE(data.length, 20);
        cd.writeUInt32LE(raw.length, 24);
        cd.writeUInt16LE(nameBuf.length, 28);
        cd.writeUInt32LE(offset, 42);
        central.push(cd, nameBuf);

        offset += local.length + nameBuf.length + data.length;
    }
    const cdBuf = Buffer.concat(central);
    const end = Buffer.alloc(22);
    end.writeUInt32LE(0x06054b50, 0);
    end.writeUInt16LE(Object.keys(entries).length, 8);
    end.writeUInt16LE(Object.keys(entries).length, 10);
    end.writeUInt32LE(cdBuf.length, 12);
    end.writeUInt32LE(offset, 16);
    return Buffer.concat([...locals, cdBuf, end]);
}

const jarWithLevel = (level, extra = {}) =>
    makeZip({ 'META-INF/MANIFEST.MF': `Manifest-Version: 1.0\r\n${level === null ? '' : `Api-Level: ${level}\r\n`}\r\n`, 'plugin.txt': 'x'.repeat(5000), ...extra });

const themeZipWithLevel = (level) =>
    makeZip({ 'manifest.json': JSON.stringify({ id: 'my-theme', ...(level === null ? {} : { apiLevel: level }) }), 'index.js': 'x'.repeat(5000) });

module.exports = { makeZip, jarWithLevel, themeZipWithLevel };
