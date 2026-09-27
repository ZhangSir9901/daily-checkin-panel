// 动态生成扩展 zip 包：把当前面板地址注入 popup.js 的 __PANEL_URL__ 占位符，
// 用户下载安装后，扩展的面板地址输入框自动带出，用户仍可手动修改。
// 极简 ZIP Writer（STORE 不压缩），零依赖。
import { EXT_FILES } from './ext-files.js';

const te = new TextEncoder();

// CRC32 表
const CRC_TABLE = (() => {
  const t = new Uint32Array(256);
  for (let n = 0; n < 256; n++) {
    let c = n;
    for (let k = 0; k < 8; k++) c = (c & 1) ? (0xEDB88320 ^ (c >>> 1)) : (c >>> 1);
    t[n] = c;
  }
  return t;
})();

function crc32(bytes) {
  let c = 0xFFFFFFFF;
  for (let i = 0; i < bytes.length; i++) c = CRC_TABLE[(c ^ bytes[i]) & 0xFF] ^ (c >>> 8);
  return (c ^ 0xFFFFFFFF) >>> 0;
}

function u16(n) {
  return new Uint8Array([n & 0xFF, (n >>> 8) & 0xFF]);
}

function u32(n) {
  return new Uint8Array([n & 0xFF, (n >>> 8) & 0xFF, (n >>> 16) & 0xFF, (n >>> 24) & 0xFF]);
}

function concat(...arrs) {
  const total = arrs.reduce((s, a) => s + a.length, 0);
  const out = new Uint8Array(total);
  let off = 0;
  for (const a of arrs) { out.set(a, off); off += a.length; }
  return out;
}

// files: [{ name: 'popup.js', data: Uint8Array }]
export function buildZip(files) {
  const chunks = [];
  const central = [];
  let offset = 0;

  for (const f of files) {
    const nameBytes = te.encode(f.name);
    const crc = crc32(f.data);
    const size = f.data.length;

    // Local file header
    const local = concat(
      u32(0x04034b50), // signature
      u16(20),         // version needed
      u16(0),          // flags
      u16(0),          // method = STORE
      u16(0), u16(0),  // time, date
      u32(crc),
      u32(size), u32(size),
      u16(nameBytes.length), u16(0), // name len, extra len
      nameBytes
    );
    chunks.push(local, f.data);

    // Central directory entry (稍后拼接)
    central.push({
      header: concat(
        u32(0x02014b50), // signature
        u16(20), u16(20), // version made by, version needed
        u16(0), u16(0),   // flags, method
        u16(0), u16(0),   // time, date
        u32(crc),
        u32(size), u32(size),
        u16(nameBytes.length), u16(0), u16(0), // name, extra, comment
        u16(0), u16(0),   // disk, int attr
        u32(0),           // ext attr
        u32(offset),      // local header offset
        nameBytes
      ),
    });
    offset += local.length + size;
  }

  const centralStart = offset;
  const centralBytes = [];
  for (const c of central) {
    centralBytes.push(c.header);
    offset += c.header.length;
  }
  const centralSize = offset - centralStart;

  const end = concat(
    u32(0x06054b50), // signature
    u16(0), u16(0),  // disk numbers
    u16(files.length), u16(files.length),
    u32(centralSize),
    u32(centralStart),
    u16(0)           // comment len
  );

  return concat(...chunks, ...centralBytes, end);
}

// 从嵌入的源文件读取，注入面板地址，打包返回（不依赖 ASSETS 或自请求）
export async function handleExtZip(req, env) {
  const url = new URL(req.url);
  const origin = url.origin; // 当前面板地址，如 https://xxx.workers.dev

  const fileNames = ['manifest.json', 'popup.html', 'popup.js', 'background.js'];
  const files = [];

  for (const name of fileNames) {
    let text = EXT_FILES[name];
    if (text == null) {
      return new Response('扩展源文件缺失：' + name, { status: 500 });
    }
    if (name === 'popup.js' || name === 'background.js') {
      // 替换所有占位符
      text = text.split('__PANEL_URL__').join(origin);
    }
    files.push({ name, data: te.encode(text) });
  }

  const zipBytes = buildZip(files);
  return new Response(zipBytes, {
    headers: {
      'Content-Type': 'application/zip',
      'Content-Disposition': 'attachment; filename="cookie-helper-extension.zip"',
      'Cache-Control': 'no-store',
    },
  });
}
