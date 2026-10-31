/*
 * printer.ts — faithful TypeScript port of the PT-P300BT printer protocol.
 *
 * Ports:
 *   - ptcbp.py            (command building / serialization)
 *   - labelmaker_encode.py (raster transfer encoding + PackBits RLE)
 *   - ptstatus.py         (32-byte status register parsing)
 *   - labelmaker.py       (do_print_job / wait_for_print_completion)
 *
 * Transport: Web Serial API (navigator.serial). Chrome/Edge on Windows,
 * macOS and Linux can talk to Bluetooth Classic RFCOMM/SPP devices
 * directly through Web Serial (Chrome 117+), without an OS serial port.
 */

// ---------------------------------------------------------------------------
// ptcbp.py — command schema
// ---------------------------------------------------------------------------
// (op bytes, mnemonic, param schema, data-length hooks)
type CommandEntry = [
  op: Uint8Array,
  mnemonic: string,
  schema: string | null,
  dataLen: string | null,
];

const CMD_SCHEMA: CommandEntry[] = [
  [new Uint8Array([0x00]), 'nop', null, null],
  [new Uint8Array([0x1b, 0x40]), 'reset', null, null],
  [new Uint8Array([0x1b, 0x69, 0x53]), 'get_status', null, null],
  [new Uint8Array([0x1b, 0x69, 0x61]), 'use_command_set', 'B', null],
  [new Uint8Array([0x1b, 0x69, 0x7a]), 'set_print_parameters', '4BI2B', null],
  [new Uint8Array([0x1b, 0x69, 0x4d]), 'set_page_mode', 'B', null],
  [new Uint8Array([0x1b, 0x69, 0x4b]), 'set_page_mode_advanced', 'B', null],
  [new Uint8Array([0x1b, 0x69, 0x64]), 'set_page_margin', 'H', null],
  [new Uint8Array([0x4d]), 'compression', 'B', null],
  [new Uint8Array([0x0c]), 'print_page', null, null],
  [new Uint8Array([0x1a]), 'print', null, null],
  [new Uint8Array([0x67]), 'data2', 'H', 'len0'],
  [new Uint8Array([0x47]), 'data', 'H', 'len0'],
  [new Uint8Array([0x5a]), 'zerofill', null, null],
];

const MNEMONICS: Record<string, CommandEntry> = {};
for (const e of CMD_SCHEMA) MNEMONICS[e[1]] = e;

// struct format -> [size, writer]
interface StructFormat {
  size: number;
  write(dv: DataView, off: number, v: number): void;
}

const STRUCT_FORMATS: Record<string, StructFormat> = {
  B: { size: 1, write: (dv, off, v) => dv.setUint8(off, v & 0xff) },
  H: { size: 2, write: (dv, off, v) => dv.setUint16(off, v & 0xffff, true) },
  I: { size: 4, write: (dv, off, v) => dv.setUint32(off, v >>> 0, true) },
};

function structFormat(code: string): StructFormat {
  const f = STRUCT_FORMATS[code];
  if (!f) throw new Error(`Unknown struct code ${code}`);
  return f;
}

// Parse a Python struct format string (little-endian) into a list of field
// codes, expanding repeat counts: "4BI2B" -> [B,B,B,B,I,B,B].
function parseSchema(schema: string): string[] {
  const fields: string[] = [];
  let count = '';
  for (const ch of schema) {
    if (ch >= '0' && ch <= '9') {
      count += ch;
      continue;
    }
    const n = count ? parseInt(count, 10) : 1;
    for (let i = 0; i < n; i++) fields.push(ch);
    count = '';
  }
  return fields;
}

function schemaSize(schema: string): number {
  let n = 0;
  for (const ch of parseSchema(schema)) n += structFormat(ch).size;
  return n;
}

function packParams(schema: string, params: number[]): Uint8Array {
  const fields = parseSchema(schema);
  const size = schemaSize(schema);
  const buf = new ArrayBuffer(size);
  const dv = new DataView(buf);
  let off = 0;
  for (const [i, code] of fields.entries()) {
    const f = structFormat(code);
    f.write(dv, off, params[i] || 0);
    off += f.size;
  }
  return new Uint8Array(buf);
}

// ---------------------------------------------------------------------------
// PackBits (TIFF) RLE — port of the `packbits` Python package used by ptcbp.
// ---------------------------------------------------------------------------
export function packbitsEncode(data: Uint8Array): Uint8Array {
  const out: number[] = [];
  const n = data.length;
  let i = 0;
  while (i < n) {
    // Count the run of identical bytes (max 128).
    let runLen = 1;
    while (i + runLen < n && data[i + runLen] === data[i] && runLen < 128) {
      runLen++;
    }
    if (runLen >= 2) {
      // Replicate run: header = 257 - runLen (as signed byte), then the byte.
      out.push((257 - runLen) & 0xff);
      out.push(data[i] ?? 0);
      i += runLen;
    } else {
      // Literal run: gather until a run of >=3 identical bytes or 128 bytes.
      const start = i;
      let litLen = 0;
      while (i < n && litLen < 128) {
        // Look ahead: stop if the next 3 bytes are identical.
        if (i + 2 < n && data[i] === data[i + 1] && data[i] === data[i + 2]) {
          break;
        }
        i++;
        litLen++;
      }
      if (litLen === 0) {
        // Safety: emit a single literal to guarantee progress.
        litLen = 1;
        i = start + 1;
      }
      out.push((litLen - 1) & 0xff);
      for (let k = 0; k < litLen; k++) out.push(data[start + k] ?? 0);
    }
  }
  return new Uint8Array(out);
}

// ---------------------------------------------------------------------------
// ptcbp.py — Opcode serialization
// ---------------------------------------------------------------------------
export function serializeControl(mnemonic: string, ...params: number[]): Uint8Array {
  const entry = MNEMONICS[mnemonic];
  if (!entry) throw new Error(`Unknown mnemonic ${mnemonic}`);
  const op = entry[0];
  const schema = entry[2];
  const parts = [op];
  if (schema) parts.push(packParams(schema, params));
  return concatBytes(parts);
}

export function serializeData(
  data: Uint8Array,
  compress: 'none' | 'rle' = 'none',
  useData2 = false,
): Uint8Array {
  const mnemonic = useData2 && compress === 'none' ? 'data2' : 'data';
  const entry = MNEMONICS[mnemonic];
  if (!entry) throw new Error(`Unknown mnemonic ${mnemonic}`);
  const op = entry[0];
  const payload = compress === 'rle' ? packbitsEncode(data) : data;
  const lenBuf = new ArrayBuffer(2);
  new DataView(lenBuf).setUint16(0, payload.length, true);
  return concatBytes([op, new Uint8Array(lenBuf), payload]);
}

function concatBytes(parts: Uint8Array[]): Uint8Array {
  let total = 0;
  for (const p of parts) total += p.length;
  const out = new Uint8Array(total);
  let off = 0;
  for (const p of parts) {
    out.set(p, off);
    off += p.length;
  }
  return out;
}

// ---------------------------------------------------------------------------
// Enums (ptcbp.py)
// ---------------------------------------------------------------------------
export const CompressionType = { none: 0, rle: 2 };
export const CommandSet = { escp: 0, ptcbp: 1, ptouch_template: 3 };
export const PageMode = { auto_cut: 1 << 6, mirror: 1 << 7 };
export const PageModeAdvanced = {
  half_cut: 1 << 2,
  no_page_chaining: 1 << 3,
  no_cutting_on_special_tape: 1 << 4,
  cut_on_last_label: 1 << 5,
  high_resolution: 1 << 6,
  preserve_buffer: 1 << 7,
};
export const PrintParameterField = {
  media_type: 1 << 1,
  width: 1 << 2,
  length: 1 << 3,
  quality: 1 << 6,
  recovery: 1 << 7,
};

// ---------------------------------------------------------------------------
// labelmaker_encode.py — encode_raster_transfer
// ---------------------------------------------------------------------------
export function* encodeRasterTransfer(data: Uint8Array, nocomp = false): Generator<Uint8Array> {
  const chunkSize = 16;
  const zeroLine = new Uint8Array(chunkSize);
  for (let i = 0; i < data.length; i += chunkSize) {
    const chunk = data.subarray(i, i + chunkSize);
    if (chunk.length === chunkSize && bytesEqual(chunk, zeroLine)) {
      yield serializeControl('zerofill');
    } else {
      yield serializeData(chunk, nocomp ? 'none' : 'rle');
    }
  }
}

function bytesEqual(a: Uint8Array, b: Uint8Array): boolean {
  if (a.length !== b.length) return false;
  for (let i = 0; i < a.length; i++) if (a[i] !== b[i]) return false;
  return true;
}

// ---------------------------------------------------------------------------
// ptstatus.py — status register parsing (32 bytes, big-endian)
// ---------------------------------------------------------------------------
type CodeTable = Record<number, string>;

const POWER: CodeTable = {
  0: 'Battery full',
  1: 'Battery half',
  2: 'Battery low',
  3: 'Battery critical',
  4: 'AC',
};
const MODELS: CodeTable = {
  56: 'QL-800',
  57: 'QL-810W',
  65: 'QL-820NWB',
  102: 'PT-E550W',
  104: 'PT-P750W',
  111: 'PT-P900W',
  112: 'PT-P950NW',
  114: 'PT-P300BT',
};
const ERR_FLAGS: CodeTable = {
  0: 'Replace media',
  1: 'Expansion buffer full',
  2: 'Communication error',
  3: 'Communication buffer full',
  4: 'Cover opened',
  5: 'Overheat/Cancelled on printer side',
  6: 'Feed error',
  7: 'General system error',
  8: 'Media not loaded',
  9: 'End of media (Page too long)',
  10: 'Cutter jammed',
  11: 'Low battery',
  12: 'Printer in use',
  13: 'Printer not powered',
  14: 'Overvoltage',
  15: 'Fan error',
};
const TAPE_TYPE: CodeTable = {
  0: 'Not loaded',
  1: 'Laminated (TZexxx)',
  3: 'Non-laminated (TZeNxxx)',
  17: 'Heat shrink tube (HSexxx)',
  74: 'Continuous tape',
  75: 'Die-cut labels',
  255: 'Unsupported',
};
const PHASES: CodeTable = {
  0: 'Ready',
  1: 'Feed',
  65536: 'Printing',
  65556: 'Cover open while receiving',
};
const TAPE_BGCOLORS: CodeTable = {
  0: 'None',
  1: 'White',
  2: 'Other',
  3: 'Clear',
  4: 'Red',
  5: 'Blue',
  6: 'Yellow',
  7: 'Green',
  8: 'Black',
  9: 'Clear (White text)',
  32: 'Matte white',
  33: 'Matte clear',
  34: 'Matte silver',
  35: 'Satin gold',
  36: 'Satin silver',
  48: 'Blue (D)',
  49: 'Red (D)',
  64: 'Fluorescent orange',
  65: 'Fluorescent yellow',
  80: 'Berry pink (S)',
  81: 'Light gray (S)',
  82: 'Lime green (S)',
  96: 'Yellow (F)',
  97: 'Pink (F)',
  98: 'Blue (F)',
  112: 'White (Heat shrink tube)',
  144: 'White (Flex ID)',
  145: 'Yellow (Flex ID)',
  240: 'Printing head cleaner',
  241: 'Stencil',
  255: 'Unsupported',
};
const TAPE_FGCOLORS: CodeTable = {
  0: 'None',
  1: 'White',
  2: 'Other',
  4: 'Red',
  5: 'Blue',
  8: 'Black',
  10: 'Gold',
  98: 'Blue (F)',
  240: 'Printing head cleaner',
  241: 'Stencil',
  255: 'Unsupported',
};
const PRINT_FLAGS: CodeTable = { 6: 'Auto cut', 7: 'Hardware mirroring' };
const STATUS_TYPE: CodeTable = {
  0: 'Reply to status request',
  1: 'Printing completed',
  2: 'Error occured',
  3: 'IF mode finished',
  4: 'Power off',
  5: 'Notification',
  6: 'Phase change',
};
const NOTIFICATIONS: CodeTable = { 0: 'N/A', 1: 'Cover open', 2: 'Cover close' };

function describeCode(code: number, table: CodeTable): string {
  const name = table[code] !== undefined ? table[code] : 'Unknown';
  return `${name} (0x${code.toString(16).padStart(2, '0')})`;
}

function describeFlag(flagset: number, descset: CodeTable): string {
  if (flagset === 0) return 'None';
  const flags: string[] = [];
  let ctr = 0;
  while (flagset !== 0) {
    if (flagset & 1) flags.push(descset[ctr] ?? `bit${ctr}`);
    ctr++;
    flagset >>>= 1;
  }
  return flags.join(', ');
}

export function unpackStatus(bytes: Uint8Array) {
  if (bytes.length !== 32) throw new Error('Status must be exactly 32 bytes long.');
  const dv = new DataView(bytes.buffer, bytes.byteOffset, bytes.byteLength);
  return {
    magic: bytes.subarray(0, 4),
    model: dv.getUint8(4),
    country: dv.getUint8(5),
    _err2: dv.getUint8(6),
    _power: dv.getUint8(7),
    err: dv.getUint16(8, false),
    tape_width: dv.getUint8(10),
    tape_type: dv.getUint8(11),
    colors: dv.getUint8(12),
    fonts: dv.getUint8(13),
    _sbz0: dv.getUint8(14),
    mode: dv.getUint8(15),
    density: dv.getUint8(16),
    tape_length: dv.getUint8(17),
    status_type: dv.getUint8(18),
    phase_type: dv.getUint8(19),
    phase: dv.getUint16(20, false),
    notification: dv.getUint8(22),
    expansion_area: dv.getUint8(23),
    tape_bgcolor: dv.getUint8(24),
    tape_fgcolor: dv.getUint8(25),
    hw_settings: dv.getUint32(26, false),
  };
}

export type PrinterStatus = ReturnType<typeof unpackStatus>;

export function printStatusLines(stat: PrinterStatus, verbose = false): string[] {
  const lines: string[] = [];
  if (!bytesEqual(stat.magic, new Uint8Array([0x80, 0x20, 0x42, 0x30]))) {
    throw new Error('Invalid magic');
  }
  lines.push(`Model: ${describeCode(stat.model, MODELS)}`);
  if (verbose) {
    lines.push(`Country: 0x${stat.country.toString(16).padStart(2, '0')}`);
    lines.push(`Extended error: 0x${stat._err2.toString(16).padStart(2, '0')}`);
    lines.push(`Power: ${describeCode(stat._power, POWER)}`);
  }
  lines.push(`Errors: ${describeFlag(stat.err, ERR_FLAGS)}`);
  lines.push(`Tape width: ${stat.tape_width}mm`);
  lines.push(`Tape type: ${describeCode(stat.tape_type, TAPE_TYPE)}`);
  lines.push(`Print flags: ${describeFlag(stat.mode, PRINT_FLAGS)}`);
  lines.push(`Fixed label length: ${stat.tape_length !== 0 ? `${stat.tape_length}mm` : 'N/A'}`);
  lines.push(`Status: ${describeCode(stat.status_type, STATUS_TYPE)}`);
  lines.push(`Phase: ${describeCode((stat.phase_type << 16) | stat.phase, PHASES)}`);
  lines.push(`Notification: ${describeCode(stat.notification, NOTIFICATIONS)}`);
  if (verbose) lines.push(`Expansion size: 0x${stat.expansion_area.toString(16).padStart(2, '0')}`);
  lines.push(`Tape background: ${describeCode(stat.tape_bgcolor, TAPE_BGCOLORS)}`);
  lines.push(`Tape foreground: ${describeCode(stat.tape_fgcolor, TAPE_FGCOLORS)}`);
  if (verbose) lines.push(`Hardware settings: 0x${stat.hw_settings.toString(16).padStart(8, '0')}`);
  return lines;
}

// ---------------------------------------------------------------------------
// labelmaker.py — printer configuration and print job
// ---------------------------------------------------------------------------
export function resetPrinterBytes(): Uint8Array[] {
  return [
    new Uint8Array(64), // flush print buffer
    serializeControl('reset'),
    serializeControl('use_command_set', CommandSet.ptcbp),
  ];
}

export interface ConfigureOptions {
  compress?: boolean;
  chaining?: boolean;
  autoCut?: boolean;
  endMargin?: number;
}

export function configurePrinterBytes(
  rasterLines: number,
  tapeDim: readonly [type: number, width: number, length: number],
  opts: ConfigureOptions = {},
): Uint8Array[] {
  const { compress = true, chaining = false, autoCut = false, endMargin = 0 } = opts;
  const [type_, width, length] = tapeDim;
  const out: Uint8Array[] = [];
  out.push(...resetPrinterBytes());

  const activeFields =
    PrintParameterField.width | PrintParameterField.quality | PrintParameterField.recovery;
  // set_print_parameters: '4BI2B' = active_fields(B), media_type(B),
  // width_mm(B), length_mm(B), length_px(I), is_follow_up(B), sbz(B)
  out.push(
    serializeControl('set_print_parameters', activeFields, type_, width, length, rasterLines, 0, 0),
  );

  let pm = 0,
    pm2 = 0;
  if (!chaining) pm2 |= PageModeAdvanced.no_page_chaining;
  if (autoCut) pm |= PageMode.auto_cut;

  out.push(serializeControl('set_page_mode_advanced', pm2));
  out.push(serializeControl('set_page_mode', pm));
  out.push(serializeControl('set_page_margin', endMargin));
  out.push(serializeControl('compression', compress ? CompressionType.rle : CompressionType.none));
  return out;
}

// ---------------------------------------------------------------------------
// Web Serial transport
// ---------------------------------------------------------------------------
// A thrown value is normally an Error or a DOMException, but `catch` gives
// `unknown`: read the fields without assuming a class.
export function errorName(e: unknown): string | undefined {
  return typeof e === 'object' && e !== null && 'name' in e ? String(e.name) : undefined;
}

export function errorMessage(e: unknown): string | undefined {
  return typeof e === 'object' && e !== null && 'message' in e ? String(e.message) : undefined;
}

// What the print job needs from a connection (tests pass a fake).
export interface PrintTransport {
  write(bytes: Uint8Array): Promise<void>;
  read(n: number, timeoutMs?: number): Promise<Uint8Array>;
  resetInputBuffer(): Promise<void>;
}

export class SerialTransport implements PrintTransport {
  port: SerialPort;
  reader: ReadableStreamDefaultReader<Uint8Array> | null;
  writer: WritableStreamDefaultWriter<Uint8Array> | null;
  _readBuffer: Uint8Array;
  _pumping = false;

  constructor(port: SerialPort) {
    this.port = port;
    this.reader = null;
    this.writer = null;
    this._readBuffer = new Uint8Array(0);
  }

  static isSupported(): boolean {
    if (typeof navigator === 'undefined' || !('serial' in navigator)) return false;
    // Firefox exposes navigator.serial but requestPort() is not implemented
    // (the API surface exists while the chooser never opens), so require the
    // method to be callable too — Chrome/Edge always provide it.
    return typeof navigator.serial.requestPort === 'function';
  }

  static async requestPort(): Promise<SerialPort> {
    // The PT-P300BT exposes the standard Bluetooth SPP (Serial Port Profile)
    // service. Chrome can access RFCOMM/SPP devices directly through Web
    // Serial; passing the SPP service class id makes the chooser list the
    // paired printer even when the OS did not create a serial port.
    const SPP_SERVICE_CLASS_ID = '00001101-0000-1000-8000-00805f9b34fb';
    try {
      return await navigator.serial.requestPort({
        allowedBluetoothServiceClassIds: [SPP_SERVICE_CLASS_ID],
      });
    } catch (e) {
      // Older Chrome builds may not accept the option: retry without it.
      if (errorName(e) !== 'TypeError') throw e;
      return await navigator.serial.requestPort();
    }
  }

  async open(baudRate = 9600, onRetry: (attempt: number) => void = () => {}): Promise<void> {
    // On macOS Chrome's first Bluetooth open from idle fails after 10 s: the
    // SDP query only reports back once the link is up. That attempt does
    // bring the link up, for about 6 s more, so an immediate retry connects.
    const bluetooth = Boolean(this.port.getInfo?.().bluetoothServiceClassId);
    for (let attempt = 1; ; attempt++) {
      try {
        await this.port.open({ baudRate });
        break;
      } catch (e) {
        if (!bluetooth || errorName(e) !== 'NetworkError' || attempt >= 3) throw e;
        onRetry(attempt);
      }
    }
    if (!this.port.writable) throw new Error('Port is not writable');
    this.writer = this.port.writable.getWriter();
    // pyserial asserts DTR/RTS when opening a port; Web Serial does not.
    // Many Bluetooth SPP devices (the PT-P300BT included) stay silent
    // until the host asserts the modem lines, which is exactly the
    // "connected but no status bytes" symptom.
    try {
      await this.port.setSignals({ dataTerminalReady: true, requestToSend: true });
    } catch (_e) {
      /* optional */
    }
    this._startReadPump();
  }

  // Continuous read pump: a single pending reader.read() at any time,
  // pushing every chunk into _readBuffer as soon as it arrives. The old
  // per-call Promise.race approach left an orphaned read() promise alive
  // after each timeout; when the response finally arrived it was consumed
  // by that dead promise and the next read() saw 0 bytes forever.
  _startReadPump(): void {
    if (this._pumping) return;
    this._pumping = true;
    const pump = async () => {
      try {
        if (!this.reader) {
          if (!this.port.readable) return;
          this.reader = this.port.readable.getReader();
        }
        while (this._pumping) {
          const { value, done } = await this.reader.read();
          if (done) break;
          if (value?.length) {
            this._readBuffer = concatBytes([this._readBuffer, value]);
          }
        }
      } catch (_e) {
        /* port closed or reader released */
      } finally {
        this._pumping = false;
      }
    };
    pump();
  }

  async write(bytes: Uint8Array): Promise<void> {
    if (!this.writer) throw new Error('Port not open');
    await this.writer.write(bytes);
  }

  async read(n: number, timeoutMs = 10000): Promise<Uint8Array> {
    // Read exactly n bytes (or fewer on timeout) from the pump buffer.
    const deadline = Date.now() + timeoutMs;
    while (this._readBuffer.length < n && Date.now() < deadline) {
      await new Promise((res) => setTimeout(res, 5));
    }
    const take = Math.min(n, this._readBuffer.length);
    const out = this._readBuffer.subarray(0, take);
    this._readBuffer = this._readBuffer.subarray(take);
    return out;
  }

  async resetInputBuffer(): Promise<void> {
    this._readBuffer = new Uint8Array(0);
  }

  async close(): Promise<void> {
    this._pumping = false;
    try {
      if (this.reader) {
        await this.reader.cancel();
        this.reader.releaseLock();
        this.reader = null;
      }
    } catch (_e) {}
    try {
      if (this.writer) {
        this.writer.releaseLock();
        this.writer = null;
      }
    } catch (_e) {}
    try {
      await this.port.close();
    } catch (_e) {}
  }
}

// ---------------------------------------------------------------------------
// labelmaker.py — do_print_job / wait_for_print_completion
// ---------------------------------------------------------------------------
export async function waitForPrintCompletion(
  transport: Pick<PrintTransport, 'read'>,
  timeout = 60,
  onLog: (line: string) => void = () => {},
): Promise<void> {
  const deadline = Date.now() + timeout * 1000;
  let buffer: Uint8Array = new Uint8Array(0);
  while (Date.now() < deadline) {
    const chunk = await transport.read(32 - buffer.length, 1000);
    buffer = concatBytes([buffer, chunk]);
    if (buffer.length < 32) continue;
    const status = unpackStatus(buffer.subarray(0, 32));
    buffer = buffer.subarray(32);
    for (const line of printStatusLines(status)) onLog(line);
    if (status.err || status.status_type === 0x02) {
      throw new Error(`Printer reported an error: ${describeFlag(status.err, ERR_FLAGS)}`);
    }
    if (status.status_type === 0x01) return;
    if (status.status_type === 0x04) {
      throw new Error('Printer powered off before completing the job.');
    }
  }
  throw new Error(`Printer did not confirm print completion within ${timeout} seconds.`);
}

// The fields of the label args that the print job reads.
export interface PrintJobArgs {
  no_feed: boolean;
  auto_cut: boolean;
  end_margin: number;
  nocomp: boolean;
  no_print?: boolean;
}

export async function doPrintJob(
  transport: PrintTransport,
  args: PrintJobArgs,
  data: Uint8Array,
  onLog: (line: string) => void = () => {},
  onProgress: (bar: string) => void = () => {},
): Promise<void> {
  onLog('=> Querying printer status...');

  let status: PrinterStatus | null = null;
  for (let attempt = 1; attempt <= 6; attempt++) {
    for (const b of resetPrinterBytes()) await transport.write(b);
    await transport.resetInputBuffer();
    await transport.write(serializeControl('get_status'));
    const resp = await transport.read(32, 1000);
    if (resp.length === 32) {
      status = unpackStatus(resp);
      break;
    }
    onLog(`   ...no status yet (attempt ${attempt}/6, got ${resp.length} bytes); retrying...`);
  }
  if (status === null) {
    throw new Error(
      'Printer did not respond to status query. Make sure it is connected and active in Bluetooth, then try again.',
    );
  }
  for (const line of printStatusLines(status)) onLog(line);

  if (status.err !== 0x0000 || status.phase_type !== 0x00 || status.phase !== 0x0000) {
    throw new Error('Printer indicates that it is not ready. Refusing to continue.');
  }

  onLog('=> Configuring printer...');
  const rasterLines = Math.floor(data.length / 16);
  const cfg = configurePrinterBytes(
    rasterLines,
    [status.tape_type, status.tape_width, status.tape_length],
    {
      chaining: args.no_feed,
      autoCut: args.auto_cut,
      endMargin: args.end_margin,
      compress: !args.nocomp,
    },
  );
  for (const b of cfg) await transport.write(b);

  onLog(`=> Sending image data (${rasterLines} lines)...`);
  const BARS = '123456789';
  let bar = '';
  for (const line of encodeRasterTransfer(data, args.nocomp)) {
    if (line[0] === 0x47) bar += BARS[Math.min(Math.floor((line.length - 3) / 2), 7) + 1];
    else if (line[0] === 0x5a) bar += BARS[0];
    onProgress(bar);
    await transport.write(line);
  }
  onLog('=> Image data was sent successfully. Printing will begin soon.');

  if (!args.no_print) {
    await transport.write(serializeControl('print'));
    await waitForPrintCompletion(transport, 60, onLog);
  }
  onLog('=> All done.');
}
