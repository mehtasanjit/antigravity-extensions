// Schemaless protobuf reading for Antigravity's on-device conversation databases.
// The format is undocumented: field paths (e.g. "1.4.2") were identified by comparing
// decoded values with what agy prints. Nothing here knows a schema.

// Decodes one message level. Returns [{ f, w, v }] or null when the bytes aren't a valid message.
export function decode(bytes) {
  const out = [];
  let i = 0;
  try {
    while (i < bytes.length) {
      const [key, afterKey] = varint(bytes, i);
      i = afterKey;
      const f = Math.floor(key / 8);
      const w = key % 8;
      if (f === 0) return null;
      if (w === 0) {
        const [v, next] = varint(bytes, i);
        i = next;
        out.push({ f, w, v });
      } else if (w === 1 || w === 5) {
        const size = w === 1 ? 8 : 4;
        if (i + size > bytes.length) return null;
        out.push({ f, w, v: bytes.subarray(i, i + size) });
        i += size;
      } else if (w === 2) {
        const [n, next] = varint(bytes, i);
        i = next;
        if (i + n > bytes.length) return null;
        out.push({ f, w, v: bytes.subarray(i, i + n) });
        i += n;
      } else {
        return null;
      }
    }
    return out;
  } catch {
    return null;
  }
}

function varint(b, start) {
  let result = 0;
  let shift = 0;
  let i = start;
  for (;;) {
    if (i >= b.length) throw new Error("truncated varint");
    const byte = b[i++];
    result += (byte & 0x7f) * 2 ** shift;
    shift += 7;
    if (!(byte & 0x80)) return [result, i];
    if (shift > 63) throw new Error("varint too long");
  }
}

// Every value at a dotted path ("1.4.2"); fields on the way must be nested messages.
export function all(bytes, path) {
  if (!bytes) return [];
  const parts = path.split(".").map(Number);
  let level = [bytes];
  for (let d = 0; d < parts.length; d++) {
    const next = [];
    for (const b of level) {
      const fields = decode(b);
      if (!fields) continue;
      for (const x of fields) {
        if (x.f !== parts[d]) continue;
        if (d === parts.length - 1) next.push(x);
        else if (x.w === 2) next.push(x.v);
      }
    }
    level = next;
  }
  return level;
}

const utf8 = (b) => Buffer.from(b).toString("utf8");

export const num = (bytes, path) => all(bytes, path).find((x) => x.w === 0)?.v ?? null;
export const text = (bytes, path) => {
  const x = all(bytes, path).find((y) => y.w === 2);
  return x ? utf8(x.v) : null;
};
export const texts = (bytes, path) => all(bytes, path).filter((x) => x.w === 2).map((x) => utf8(x.v));
export const messages = (bytes, path) => all(bytes, path).filter((x) => x.w === 2).map((x) => x.v);

// A google.protobuf.Timestamp-shaped message (1 seconds, 2 nanos) at a path, as epoch milliseconds.
export function timestampMs(bytes, path) {
  const m = messages(bytes, path)[0];
  if (!m) return null;
  const seconds = num(m, "1");
  if (seconds === null) return null;
  return seconds * 1000 + Math.floor((num(m, "2") ?? 0) / 1e6);
}
