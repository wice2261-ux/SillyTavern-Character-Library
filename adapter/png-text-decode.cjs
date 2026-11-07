// Local diagnostic patch: bounded PNG tEXt decoding (2026-11-05).
// Server-side replacement for png-chunk-text/decode.js; preserves byte semantics.
module.exports = decode

function decode (data) {
  if (data.data && data.name) {
    data = data.data
  }

  var bytes = Buffer.isBuffer(data)
    ? data
    : data instanceof Uint8Array
      ? Buffer.from(data.buffer, data.byteOffset, data.byteLength)
      : Buffer.from(data)
  var separator = bytes.indexOf(0)

  if (separator < 0) {
    return { keyword: bytes.toString('latin1'), text: '' }
  }
  if (bytes.indexOf(0, separator + 1) !== -1) {
    throw new Error('Invalid NULL character found. 0x00 character is not permitted in tEXt content')
  }

  return {
    keyword: bytes.toString('latin1', 0, separator),
    text: bytes.toString('latin1', separator + 1)
  }
}
