export type CsiParams = (number | number[])[];

export interface CsiIdentifier {
  prefix?: string;
  intermediates?: string;
  final: string;
}

export type CsiHandler = (params: CsiParams) => void;

type State = 'ground' | 'escape' | 'csi' | 'string' | 'string-escape';

const ESC = 0x1b;
const BEL = 0x07;
const CSI_INTRODUCER = 0x5b;
const STRING_INTRODUCERS = new Set([0x5d, 0x50, 0x5f, 0x5e, 0x58]);
const MAX_SEQUENCE = 256;

/**
 * Watches a byte stream for CSI sequences without parsing the terminal state.
 * It follows the stream across chunks and skips OSC, DCS, APC, PM and SOS
 * strings, so text inside them never counts as a sequence.
 */
export class CsiObserver {
  private state: State = 'ground';
  private body = '';
  private readonly handlers = new Map<string, Set<CsiHandler>>();

  get active(): boolean {
    return this.handlers.size > 0;
  }

  register(id: CsiIdentifier, handler: CsiHandler): { dispose(): void } {
    const key = keyOf(id.prefix ?? '', id.intermediates ?? '', id.final);
    const set = this.handlers.get(key) ?? new Set<CsiHandler>();
    set.add(handler);
    this.handlers.set(key, set);
    return {
      dispose: () => {
        set.delete(handler);
        if (set.size === 0) this.handlers.delete(key);
      },
    };
  }

  /**
   * Advances over the byte at `index`. When it ends a sequence with handlers,
   * `before(index)` runs first, so the caller can hand the terminal everything
   * before that byte, and the handlers then see the state the sequence found.
   */
  step(byte: number, index: number, before: (index: number) => void): void {
    switch (this.state) {
      case 'ground':
        if (byte === ESC) this.state = 'escape';
        return;
      case 'escape':
        if (byte === CSI_INTRODUCER) {
          this.state = 'csi';
          this.body = '';
        } else if (STRING_INTRODUCERS.has(byte)) {
          this.state = 'string';
        } else {
          this.state = byte === ESC ? 'escape' : 'ground';
        }
        return;
      case 'string':
        if (byte === BEL) this.state = 'ground';
        else if (byte === ESC) this.state = 'string-escape';
        return;
      case 'string-escape':
        this.state = byte === 0x5c ? 'ground' : byte === ESC ? 'string-escape' : 'string';
        return;
      case 'csi':
        this.csiByte(byte, index, before);
    }
  }

  private csiByte(byte: number, index: number, before: (index: number) => void): void {
    if (byte >= 0x40 && byte <= 0x7e) {
      this.state = 'ground';
      this.dispatch(this.body, String.fromCharCode(byte), index, before);
      return;
    }
    if (byte === ESC) {
      this.state = 'escape';
      return;
    }
    if (byte < 0x20 || byte > 0x3f) {
      if (byte >= 0x20 && byte <= 0x2f) this.body += String.fromCharCode(byte);
      else if (byte === 0x18 || byte === 0x1a) this.state = 'ground';
      return;
    }
    this.body += String.fromCharCode(byte);
    if (this.body.length > MAX_SEQUENCE) this.state = 'ground';
  }

  private dispatch(
    body: string,
    final: string,
    index: number,
    before: (index: number) => void
  ): void {
    const match = /^([<=>?]?)([0-9;:]*)([ -/]*)$/.exec(body);
    if (!match) return;
    const handlers = this.handlers.get(keyOf(match[1], match[3], final));
    if (!handlers) return;
    before(index);
    const params = parseParams(match[2]);
    for (const handler of [...handlers]) handler(params);
  }
}

function keyOf(prefix: string, intermediates: string, final: string): string {
  return `${prefix}|${intermediates}|${final}`;
}

function parseParams(text: string): CsiParams {
  if (text === '') return [];
  return text.split(';').map((part) => {
    if (!part.includes(':')) return part === '' ? 0 : Number(part);
    return part.split(':').map((sub) => (sub === '' ? 0 : Number(sub)));
  });
}
