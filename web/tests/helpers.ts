// Shared by the unit and the browser tests.

import { resolve } from 'node:path';
import type { LabelArgs } from '../src/label';

export const REPO_ROOT = resolve(import.meta.dirname, '../..');
export const FIXTURES = resolve(REPO_ROOT, 'tests/fixtures');
export const FONT_PATH = resolve(FIXTURES, 'FiraCode-subset.ttf');
export const FONT_FAMILY = 'Fira Code';

// The args that printlabel.py gets from its defaults (mirrors ref_raster.py CASES).
export function baseArgs(over: Partial<LabelArgs> = {}): LabelArgs {
  return {
    comport: 'web-serial',
    fontname: FONT_FAMILY,
    text_to_print: ['Hello'],
    unicode: false,
    lines: false,
    image: null,
    merge: [],
    resize: 1.0,
    x_merge: 0,
    y_merge: 12,
    merge_gap: 0,
    no_print: false,
    no_feed: false,
    auto_cut: false,
    end_margin: 0,
    raw: false,
    nocomp: false,
    fill: 'black',
    stroke_fill: null,
    stroke_width: 0,
    text_size: null,
    font_scale: null,
    h_padding: 5,
    v_shift: 0,
    line_spacing: 1.2,
    center_text: false,
    tape_width: 12.0,
    emoji_print_area: false,
    uniform_font: false,
    ligatures: null,
    mono_emoji: true,
    luma_lo: 140,
    luma_hi: 175,
    tab_width: 8,
    white_level: 240,
    threshold: 75,
    fixed_width: null,
    fixed_font_size: null,
    ...over,
  };
}
