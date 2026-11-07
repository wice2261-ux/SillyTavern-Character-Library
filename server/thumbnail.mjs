import { createJimp } from '@jimp/core';
import png from '@jimp/js-png';
import jpeg from '@jimp/js-jpeg';
import { methods } from '@jimp/plugin-resize';

// These codecs ship with 1.18.0 and read local PNGs without fetching a WASM module.
const Image = createJimp({ formats: [png, jpeg], plugins: [methods] });

export async function makeThumbnail(filename) {
    const image = await Image.read(filename);
    return image.scaleToFit({ w: 72, h: 96 }).getBuffer('image/jpeg', { quality: 75 });
}
