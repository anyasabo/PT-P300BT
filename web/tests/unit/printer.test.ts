/*
 * Verifies the printer-protocol port against the Python reference (ptcbp.py,
 * labelmaker_encode.py, ptstatus.py): hand-checked values, and the golden file
 * that tests/test_protocol_golden.py compares with the Python code.
 */

import { readFileSync } from 'node:fs';
import { resolve } from 'node:path';
import { describe, expect, test } from 'vitest';
import * as P from '../../src/printer';
import { FIXTURES } from '../helpers';

function hex(bytes: Uint8Array): string {
  return Array.from(bytes)
    .map((b) => b.toString(16).padStart(2, '0'))
    .join('');
}

function unhex(s: string): Uint8Array {
  return Uint8Array.from(Buffer.from(s, 'hex'));
}

function concat(parts: Uint8Array[]): Uint8Array {
  return Uint8Array.from(parts.flatMap((p) => [...p]));
}

function mkStatus(type: number): Uint8Array {
  const s = new Uint8Array(32);
  s.set([0x80, 0x20, 0x42, 0x30], 0); // magic
  s[18] = type; // status_type
  s[19] = 0x00; // phase_type = ready
  return s;
}

describe('serializeControl', () => {
  test.each([
    ['reset', [], '1b40'],
    ['get_status', [], '1b6953'],
    ['use_command_set', [1], '1b696101'],
    ['set_page_mode', [0], '1b694d00'],
    ['set_page_mode_advanced', [8], '1b694b08'],
    ['set_page_margin', [0], '1b69640000'],
    ['compression', [2], '4d02'],
    ['print', [], '1a'],
    ['zerofill', [], '5a'],
    // '4BI2B' = B,B,B,B,I,B,B; active_fields = width|quality|recovery = 4|64|128 = 196
    ['set_print_parameters', [196, 1, 12, 0, 16, 0, 0], '1b697ac4010c00100000000000'],
  ] as [string, number[], string][])('%s', (mnemonic, params, expected) => {
    expect(hex(P.serializeControl(mnemonic, ...params))).toBe(expected);
  });
});

describe('packbitsEncode', () => {
  test('run of 5 zeros', () => {
    // Header 257-5=252 (0xfc), then the byte.
    expect(hex(P.packbitsEncode(new Uint8Array([0, 0, 0, 0, 0])))).toBe('fc00');
  });

  test('literal 1,2,3', () => {
    // Header 2, then the bytes.
    expect(hex(P.packbitsEncode(new Uint8Array([1, 2, 3])))).toBe('02010203');
  });

  test('run+literal', () => {
    expect(hex(P.packbitsEncode(new Uint8Array([9, 9, 1, 2, 3])))).toBe('ff0902010203');
  });
});

describe('serializeData', () => {
  // data opcode 'G' (0x47) + length (LE uint16) + payload.
  test('data none', () => {
    expect(hex(P.serializeData(new Uint8Array([1, 2, 3]), 'none'))).toBe('470300010203');
  });

  test('data rle', () => {
    expect(hex(P.serializeData(new Uint8Array([0, 0, 0, 0, 0]), 'rle'))).toBe('470200fc00');
  });
});

describe('encodeRasterTransfer', () => {
  test('a zero line is zerofill, a non-zero line is data', () => {
    const data = new Uint8Array(32);
    data[16] = 0xff;
    const lines = [...P.encodeRasterTransfer(data, false)];
    expect(lines.length).toBe(2);
    expect(hex(lines[0] ?? new Uint8Array())).toBe('5a');
    expect(lines[1]?.[0]).toBe(0x47);
  });
});

describe('unpackStatus', () => {
  const frame = new Uint8Array(32);
  frame.set([0x80, 0x20, 0x42, 0x30], 0); // magic
  frame[4] = 0x72; // model PT-P300BT
  frame[8] = 0x08; // err = 0x0800 (low battery)
  frame[9] = 0x00;
  frame[10] = 12; // tape width
  frame[11] = 1; // tape type
  frame[18] = 0x02; // status_type error
  frame[19] = 0x01; // phase_type
  frame.set([0x01, 0x02, 0x03, 0x04], 26);
  const st = P.unpackStatus(frame);

  test('fields', () => {
    expect(st.model).toBe(0x72);
    expect(st.err).toBe(0x0800);
    expect(st.tape_width).toBe(12);
    expect(st.status_type).toBe(0x02);
    expect(st.hw_settings).toBe(0x01020304);
  });

  test('printStatusLines', () => {
    const lines = P.printStatusLines(st);
    expect(lines.some((l) => l.includes('Low battery'))).toBe(true);
    expect(lines.some((l) => l.includes('PT-P300BT'))).toBe(true);
  });
});

describe('configurePrinterBytes', () => {
  test('commands in order', () => {
    const parts = P.configurePrinterBytes(16, [1, 12, 0], {
      chaining: false,
      autoCut: false,
      endMargin: 0,
      compress: true,
    });
    // 64-byte flush + reset + use_command_set + set_print_parameters +
    // set_page_mode_advanced + set_page_mode + set_page_margin + compression
    expect(parts.length).toBe(8);
    expect(parts[0]?.length).toBe(64);
    expect(hex(parts[1] ?? new Uint8Array())).toBe('1b40');
    expect(hex(parts[2] ?? new Uint8Array())).toBe('1b696101');
    expect(parts[3]?.[0]).toBe(0x1b);
    expect(hex(parts[4] ?? new Uint8Array())).toBe('1b694b08');
    expect(hex(parts[5] ?? new Uint8Array())).toBe('1b694d00');
    expect(hex(parts[6] ?? new Uint8Array())).toBe('1b69640000');
    expect(hex(parts[7] ?? new Uint8Array())).toBe('4d02');
  });
});

describe('doPrintJob (fake transport)', () => {
  test('sends the job and ends with the print command', async () => {
    const written: Uint8Array[] = [];
    let reads = 0;
    const fake: P.PrintTransport = {
      async write(b) {
        written.push(b.slice());
      },
      async read() {
        reads++;
        return reads === 1 ? mkStatus(0x00) : mkStatus(0x01);
      },
      async resetInputBuffer() {},
    };
    const data = new Uint8Array(32); // two raster lines
    data[16] = 0xff;
    const logs: string[] = [];
    await P.doPrintJob(
      fake,
      { nocomp: false, no_feed: false, auto_cut: false, end_margin: 0 },
      data,
      (l) => logs.push(l),
      () => {},
    );
    expect(written.length).toBeGreaterThan(0);
    expect(logs.some((l) => l.includes('Querying printer status'))).toBe(true);
    expect(logs.some((l) => l.includes('Configuring printer'))).toBe(true);
    expect(written.at(-1)?.at(-1)).toBe(0x1a);
  });
});

describe('waitForPrintCompletion', () => {
  test('completes when status_type 0x01 arrives', async () => {
    let reads = 0;
    const fake = {
      async read() {
        reads++;
        return reads === 1 ? mkStatus(0x00) : mkStatus(0x01);
      },
    };
    await expect(P.waitForPrintCompletion(fake, 5, () => {})).resolves.toBeUndefined();
  });

  test('throws on error status', async () => {
    const fake = {
      async read() {
        const s = mkStatus(0x02);
        s[8] = 0x08;
        return s;
      },
    };
    await expect(P.waitForPrintCompletion(fake, 5, () => {})).rejects.toThrow();
  });
});

interface ProtocolFixture {
  control: Record<'reset' | 'get_status' | 'print' | 'zerofill' | 'set_page_margin', string>;
  data: Record<'none' | 'rle', string>;
  raster: { input: string; compressed: string[]; uncompressed: string[] };
  configure: Record<'default' | 'auto_cut_chain_margin', string>;
}

describe('protocol.json (same file as tests/test_protocol_golden.py)', () => {
  const golden = JSON.parse(
    readFileSync(resolve(FIXTURES, 'protocol.json'), 'utf8'),
  ) as ProtocolFixture;

  test('control commands', () => {
    expect(hex(P.serializeControl('reset'))).toBe(golden.control.reset);
    expect(hex(P.serializeControl('get_status'))).toBe(golden.control.get_status);
    expect(hex(P.serializeControl('print'))).toBe(golden.control.print);
    expect(hex(P.serializeControl('zerofill'))).toBe(golden.control.zerofill);
    expect(hex(P.serializeControl('set_page_margin', 300))).toBe(golden.control.set_page_margin);
  });

  test('data', () => {
    expect(hex(P.serializeData(new Uint8Array([1, 2, 3]), 'none'))).toBe(golden.data.none);
    expect(hex(P.serializeData(new Uint8Array(5), 'rle'))).toBe(golden.data.rle);
  });

  test('raster, compressed', () => {
    const lines = [...P.encodeRasterTransfer(unhex(golden.raster.input))];
    expect(lines.map(hex)).toEqual(golden.raster.compressed);
  });

  test('raster, uncompressed', () => {
    const lines = [...P.encodeRasterTransfer(unhex(golden.raster.input), true)];
    expect(lines.map(hex)).toEqual(golden.raster.uncompressed);
  });

  test('configure, default', () => {
    expect(hex(concat(P.configurePrinterBytes(16, [1, 12, 0])))).toBe(golden.configure.default);
  });

  test('configure, auto cut + chaining + margin', () => {
    const parts = P.configurePrinterBytes(640, [1, 12, 0], {
      compress: false,
      chaining: true,
      autoCut: true,
      endMargin: 14,
    });
    expect(hex(concat(parts))).toBe(golden.configure.auto_cut_chain_margin);
  });
});
