// MD5 implementation for Cloudflare Workers.
// Public domain. Algorithm per RFC 1321 (R. Rivest, April 1992).
//
// Web Crypto API (crypto.subtle.digest) deliberately omits MD5 as deprecated,
// but PayFast ITN signatures still require it, so we ship our own.
//
// Input is a JavaScript string. Internally UTF-8 encoded before hashing — this
// matches PHP md5() behaviour on UTF-8 source bytes, which is what PayFast does.
// Output is a 32-character lowercase hex string.
//
// Constants T[i] and per-round shift counts are taken verbatim from RFC 1321
// §3.4 and §3.4 Appendix A.3 so any reviewer can diff against the spec.
//
// Verified against the RFC 1321 test suite in test/verify.test.js.

const T = new Uint32Array([
  0xd76aa478, 0xe8c7b756, 0x242070db, 0xc1bdceee,
  0xf57c0faf, 0x4787c62a, 0xa8304613, 0xfd469501,
  0x698098d8, 0x8b44f7af, 0xffff5bb1, 0x895cd7be,
  0x6b901122, 0xfd987193, 0xa679438e, 0x49b40821,
  0xf61e2562, 0xc040b340, 0x265e5a51, 0xe9b6c7aa,
  0xd62f105d, 0x02441453, 0xd8a1e681, 0xe7d3fbc8,
  0x21e1cde6, 0xc33707d6, 0xf4d50d87, 0x455a14ed,
  0xa9e3e905, 0xfcefa3f8, 0x676f02d9, 0x8d2a4c8a,
  0xfffa3942, 0x8771f681, 0x6d9d6122, 0xfde5380c,
  0xa4beea44, 0x4bdecfa9, 0xf6bb4b60, 0xbebfbc70,
  0x289b7ec6, 0xeaa127fa, 0xd4ef3085, 0x04881d05,
  0xd9d4d039, 0xe6db99e5, 0x1fa27cf8, 0xc4ac5665,
  0xf4292244, 0x432aff97, 0xab9423a7, 0xfc93a039,
  0x655b59c3, 0x8f0ccc92, 0xffeff47d, 0x85845dd1,
  0x6fa87e4f, 0xfe2ce6e0, 0xa3014314, 0x4e0811a1,
  0xf7537e82, 0xbd3af235, 0x2ad7d2bb, 0xeb86d391,
]);

const S = [
  7, 12, 17, 22,
  5,  9, 14, 20,
  4, 11, 16, 23,
  6, 10, 15, 21,
];

function indexK(round, i) {
  if (round === 0) return i;
  if (round === 1) return (5 * i + 1) & 15;
  if (round === 2) return (3 * i + 5) & 15;
  return (7 * i) & 15;
}

const auxF = (x, y, z) => (x & y) | (~x & z);
const auxG = (x, y, z) => (x & z) | (y & ~z);
const auxH = (x, y, z) => x ^ y ^ z;
const auxI = (x, y, z) => y ^ (x | ~z);

function rotl(v, n) {
  return ((v << n) | (v >>> (32 - n))) >>> 0;
}

const utf8 = new TextEncoder();

export function md5(input) {
  const bytes = utf8.encode(String(input));
  const bitLenLow = (bytes.length * 8) >>> 0;
  const bitLenHigh = Math.floor(bytes.length / 0x20000000) >>> 0;

  const paddedLen = Math.ceil((bytes.length + 9) / 64) * 64;
  const padded = new Uint8Array(paddedLen);
  padded.set(bytes);
  padded[bytes.length] = 0x80;
  const view = new DataView(padded.buffer);
  view.setUint32(paddedLen - 8, bitLenLow, true);
  view.setUint32(paddedLen - 4, bitLenHigh, true);

  let a0 = 0x67452301;
  let b0 = 0xefcdab89;
  let c0 = 0x98badcfe;
  let d0 = 0x10325476;

  const M = new Uint32Array(16);
  for (let off = 0; off < paddedLen; off += 64) {
    for (let j = 0; j < 16; j++) {
      M[j] = view.getUint32(off + j * 4, true);
    }

    let A = a0, B = b0, C = c0, D = d0;

    for (let i = 0; i < 64; i++) {
      const round = i >>> 4;
      let f;
      if (round === 0) f = auxF(B, C, D);
      else if (round === 1) f = auxG(B, C, D);
      else if (round === 2) f = auxH(B, C, D);
      else f = auxI(B, C, D);

      const kk = indexK(round, i & 15);
      const ss = S[round * 4 + (i & 3)];

      const temp = D;
      D = C;
      C = B;
      B = (B + rotl((A + f + M[kk] + T[i]) >>> 0, ss)) >>> 0;
      A = temp;
    }

    a0 = (a0 + A) >>> 0;
    b0 = (b0 + B) >>> 0;
    c0 = (c0 + C) >>> 0;
    d0 = (d0 + D) >>> 0;
  }

  const out = new Uint8Array(16);
  const outView = new DataView(out.buffer);
  outView.setUint32(0,  a0, true);
  outView.setUint32(4,  b0, true);
  outView.setUint32(8,  c0, true);
  outView.setUint32(12, d0, true);

  let hex = '';
  for (let i = 0; i < 16; i++) hex += out[i].toString(16).padStart(2, '0');
  return hex;
}
