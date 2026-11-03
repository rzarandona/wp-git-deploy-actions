// Independent Node reference encoder for DCE/1 (spec §H.6), shared by the
// contract checkers. It is written from the specification, not from the PHP
// implementation. Byte comparisons use Buffer.compare, never JavaScript's
// UTF-16 string order (unless utf16Sort is set, to prove the vectors catch it).

export class EncodingError extends Error {}

const u32 = (n) => { const b = Buffer.alloc(4); b.writeUInt32BE(n); return b; };
const u16 = (n) => { const b = Buffer.alloc(2); b.writeUInt16BE(n); return b; };

function assertText(s) {
  const bytes = Buffer.from(s, 'utf8');
  if (bytes.toString('utf8') !== s) throw new EncodingError('invalid UTF-8');
  if (s.normalize('NFC') !== s) throw new EncodingError('non-NFC string');
  return bytes;
}

/** Encodes a typed tree {t, v}: null, false, true, int, bytes (hex), string, list, set, map ([key, value] pairs). */
export function enc(t, utf16Sort = false) {
  const e = (x) => enc(x, utf16Sort);
  switch (t.t) {
    case 'null': return Buffer.from([0x00]);
    case 'false': return Buffer.from([0x01]);
    case 'true': return Buffer.from([0x02]);
    case 'int': { const b = Buffer.alloc(9); b[0] = 0x03; b.writeBigInt64BE(BigInt(t.v), 1); return b; }
    case 'bytes': { const raw = Buffer.from(t.v, 'hex'); return Buffer.concat([Buffer.from([0x04]), u32(raw.length), raw]); }
    case 'string': {
      if (t.v_hex !== undefined) {
        const raw = Buffer.from(t.v_hex, 'hex');
        if (!raw.equals(Buffer.from(raw.toString('utf8'), 'utf8'))) throw new EncodingError('invalid UTF-8');
      }
      const raw = assertText(t.v);
      return Buffer.concat([Buffer.from([0x05]), u32(raw.length), raw]);
    }
    case 'list': return Buffer.concat([Buffer.from([0x06]), u32(t.v.length), ...t.v.map(e)]);
    case 'set': {
      const items = t.v.map(e);
      items.sort(Buffer.compare);
      for (let i = 1; i < items.length; i++) if (items[i - 1].equals(items[i])) throw new EncodingError('duplicate set element');
      return Buffer.concat([Buffer.from([0x07]), u32(items.length), ...items]);
    }
    case 'map': {
      const pairs = t.v.map(([k, v]) => [k, assertText(k), v]);
      if (utf16Sort) pairs.sort((a, b) => (a[0] < b[0] ? -1 : a[0] > b[0] ? 1 : 0));
      else pairs.sort((a, b) => Buffer.compare(a[1], b[1]));
      const out = [Buffer.from([0x08]), u32(pairs.length)];
      for (let i = 0; i < pairs.length; i++) {
        if (i > 0 && pairs[i - 1][1].equals(pairs[i][1])) throw new EncodingError('duplicate map key');
        out.push(Buffer.from([0x05]), u32(pairs[i][1].length), pairs[i][1], e(pairs[i][2]));
      }
      return Buffer.concat(out);
    }
  }
  throw new EncodingError('unknown tag ' + t.t);
}

export function dce(domain, t, utf16Sort = false) {
  const d = Buffer.from(domain, 'ascii');
  return Buffer.concat([Buffer.from('DCE1\x00', 'latin1'), u16(d.length), d, enc(t, utf16Sort)]);
}
