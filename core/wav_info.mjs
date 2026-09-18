/*
 * Force Kit Builder — WAV sample-frame counting (MPC `.xpm` SliceEnd fix).
 *
 * Ported from schwung-kit-builder's src/core/wav_info.mjs. `wavFrameCount()`
 * is unchanged (pure bytes-in/number-out). `base64Decode()` is dropped — it
 * only existed because Move's `host_read_file_base64` was the one binary-safe
 * read primitive on that host; Node's `fs.readFileSync()` returns a real
 * `Buffer` directly, so callers (storage.mjs) just pass that straight in.
 *
 * The MPC `.xpm` reference kept its populated Layer-1 <SliceEnd> at the real
 * sample's frame count (33688, for a genuine 1-shot); a naive template
 * substitution leaves every pad's SliceEnd at that same layer's inert `0`
 * default instead. SliceStart 0 + SliceEnd 0 is a zero-length region, so the
 * pad plays silence — confirmed on a real Akai Force. This module computes
 * the real value from the sample's own WAV header.
 *
 * Pure module: bytes in, number out.
 */

function u32le(b, o) {
    return (b[o] | (b[o + 1] << 8) | (b[o + 2] << 16) | (b[o + 3] << 24)) >>> 0;
}
function tag(b, o) {
    return String.fromCharCode(b[o], b[o + 1], b[o + 2], b[o + 3]);
}

/* wavFrameCount(bytes) -> number | null
 * Walks a little-endian RIFF/WAVE's chunks for `fmt ` (channels, bits per
 * sample) and `data` (byte length); returns dataBytes / blockAlign. null for
 * anything that isn't a well-formed WAV we can read (AIFF, truncated, a
 * shape we don't understand) — caller falls back to the old SliceEnd 0. */
export function wavFrameCount(bytes) {
    const b = bytes instanceof Uint8Array ? bytes : Uint8Array.from(bytes || []);
    if (b.length < 12 || tag(b, 0) !== 'RIFF' || tag(b, 8) !== 'WAVE') return null;

    let channels = 0, bitsPerSample = 0, dataSize = -1;
    let o = 12;
    while (o + 8 <= b.length) {
        const id = tag(b, o);
        const size = u32le(b, o + 4);
        const body = o + 8;
        if (body + size > b.length) break;             // truncated chunk — stop here
        if (id === 'fmt ' && size >= 16) {
            channels = b[body + 2] | (b[body + 3] << 8);
            bitsPerSample = b[body + 14] | (b[body + 15] << 8);
        } else if (id === 'data') {
            dataSize = size;
        }
        o = body + size + (size & 1);                  // chunks are word-aligned
    }
    if (!channels || !bitsPerSample || dataSize < 0) return null;
    const blockAlign = channels * (bitsPerSample >> 3);
    return blockAlign > 0 ? Math.floor(dataSize / blockAlign) : null;
}

/* Locate the `fmt ` and `data` chunks together — shared walk used by
 * wav_rms.mjs so it doesn't duplicate this parsing. Returns null for
 * anything wavFrameCount() would also reject. */
export function wavChunks(bytes) {
    const b = bytes instanceof Uint8Array ? bytes : Uint8Array.from(bytes || []);
    if (b.length < 12 || tag(b, 0) !== 'RIFF' || tag(b, 8) !== 'WAVE') return null;

    let channels = 0, bitsPerSample = 0, audioFormat = 0;
    let dataOffset = -1, dataSize = -1;
    let o = 12;
    while (o + 8 <= b.length) {
        const id = tag(b, o);
        const size = u32le(b, o + 4);
        const body = o + 8;
        if (body + size > b.length) break;
        if (id === 'fmt ' && size >= 16) {
            audioFormat = b[body] | (b[body + 1] << 8);
            channels = b[body + 2] | (b[body + 3] << 8);
            bitsPerSample = b[body + 14] | (b[body + 15] << 8);
        } else if (id === 'data') {
            dataOffset = body;
            dataSize = size;
        }
        o = body + size + (size & 1);
    }
    if (!channels || !bitsPerSample || dataOffset < 0) return null;
    return { bytes: b, audioFormat, channels, bitsPerSample, dataOffset, dataSize };
}
