const zlib = require("node:zlib");

// Prints the data URL behind --hlg-ramp in globals.css: a black-to-white signal
// ramp in BT.2100 HLG. Signal 1.0 is the display's own peak, so the right end
// reaches whatever the screen can show without this file naming a luminance.
const WIDTH = 1024;
const CICP_BT2100_HLG = [9, 18, 0, 1]; // BT.2020 primaries, HLG transfer, RGB, full range

const crcTable = Array.from({ length: 256 }, (_, n) => {
  let c = n;
  for (let k = 0; k < 8; k++) c = c & 1 ? 0xedb88320 ^ (c >>> 1) : c >>> 1;
  return c >>> 0;
});

function crc32(buffer) {
  let crc = 0xffffffff;
  for (const byte of buffer) crc = crcTable[(crc ^ byte) & 0xff] ^ (crc >>> 8);
  return (crc ^ 0xffffffff) >>> 0;
}

function chunk(type, data) {
  const body = Buffer.concat([Buffer.from(type, "latin1"), data]);
  const length = Buffer.alloc(4); length.writeUInt32BE(data.length);
  const crc = Buffer.alloc(4); crc.writeUInt32BE(crc32(body));
  return Buffer.concat([length, body, crc]);
}

const header = Buffer.alloc(13);
header.writeUInt32BE(WIDTH, 0);
header.writeUInt32BE(1, 4);
header.set([16, 2, 0, 0, 0], 8); // 16-bit RGB

const row = Buffer.alloc(1 + WIDTH * 6);
for (let x = 0; x < WIDTH; x++) {
  const level = Math.round(x / (WIDTH - 1) * 0xffff);
  for (let channel = 0; channel < 3; channel++) row.writeUInt16BE(level, 1 + x * 6 + channel * 2);
}

const png = Buffer.concat([
  Buffer.from([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a]),
  chunk("IHDR", header),
  chunk("cICP", Buffer.from(CICP_BT2100_HLG)),
  chunk("IDAT", zlib.deflateSync(row, { level: 9 })),
  chunk("IEND", Buffer.alloc(0)),
]);
process.stdout.write(`data:image/png;base64,${png.toString("base64")}\n`);
