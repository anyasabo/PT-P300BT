// Runs before each test file: label.ts needs `document` when it is imported.
// The browser objects are backed by node-canvas, which measures with the same
// FreeType metrics as Pillow.

import { createCanvas, registerFont } from 'canvas';
import { FONT_FAMILY, FONT_PATH } from '../helpers';

// node-canvas needs the font before the first canvas exists.
registerFont(FONT_PATH, { family: FONT_FAMILY });

class ImageStub {
  onerror: (() => void) | null = null;
  _src = '';

  set src(v: string) {
    this._src = v;
    this.onerror?.();
  }
}

// No createElementNS and no body: label.ts then takes its no-SVG path.
const documentStub = {
  createElement(tag: string) {
    return tag === 'canvas' ? createCanvas(1, 1) : {};
  },
};

Object.assign(globalThis, { document: documentStub, Image: ImageStub });
