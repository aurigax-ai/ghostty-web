import { afterEach, describe, expect, test } from 'vitest';
import type { SemanticPromptEvent } from './ghostty';
import type { IMarker } from './marker';
import type { Terminal } from './terminal';
import { createIsolatedTerminal } from './test-helpers';

let term: Terminal | null = null;

async function openTerminal(cols = 40, rows = 5): Promise<Terminal> {
  term = await createIsolatedTerminal({ cols, rows });
  term.open(document.createElement('div'));
  return term;
}

afterEach(() => {
  term?.dispose();
  term = null;
});

describe('host hooks', () => {
  test('reports prompt marks in order with the cursor exact inside the handler', async () => {
    const t = await openTerminal();
    const seen: (SemanticPromptEvent & { x: number })[] = [];
    t.onSemanticPrompt((e) => seen.push({ ...e, x: t.buffer.active.cursorX }));
    t.write('\x1b]133;A\x07~ $ \x1b]133;B\x07ls\r\n\x1b]133;C\x07a b\r\n\x1b]133;D;1\x07');
    expect(seen.map((e) => [e.kind, e.x, e.exitCode])).toEqual([
      ['prompt-start', 0, undefined],
      ['input-start', 4, undefined],
      ['output-start', 0, undefined],
      ['command-end', 0, 1],
    ]);
  });

  test('keeps a marker on its line as output scrolls it into scrollback', async () => {
    const t = await openTerminal(40, 5);
    let marker: IMarker | undefined;
    t.onSemanticPrompt((e) => {
      if (e.kind === 'prompt-start') marker = t.registerMarker(0);
    });
    t.write('first\r\n\x1b]133;A\x07~ $ marked\r\n');
    const startLine = marker!.line;
    for (let i = 0; i < 20; i++) t.write(`output ${i}\r\n`);
    expect(marker!.line).toBe(startLine);
    expect(t.buffer.active.baseY).toBeGreaterThan(startLine);
    expect(t.buffer.active.getLine(marker!.line)?.translateToString(true)).toBe('~ $ marked');
  });

  test('disposes a marker when its terminal resets', async () => {
    const t = await openTerminal();
    const marker = t.registerMarker(0)!;
    let disposed = false;
    marker.onDispose(() => {
      disposed = true;
    });
    t.reset();
    expect(disposed).toBe(true);
    expect(marker.line).toBe(-1);
  });

  test('passes OSC 7 through raw, host and percent signs included', async () => {
    const t = await openTerminal();
    const seen: string[] = [];
    t.onPwdChange((pwd) => seen.push(pwd));
    t.write('\x1b]7;file://build-box/home/me/100%20off\x07');
    expect(seen).toEqual(['file://build-box/home/me/100%20off']);
  });

  test('reports OSC 9 and OSC 777 notifications and OSCs it does not implement', async () => {
    const t = await openTerminal();
    const notes: string[] = [];
    const unknown: string[] = [];
    t.onDesktopNotification((n) => notes.push(`${n.title}|${n.body}`));
    t.onUnknownOsc((content) => unknown.push(content));
    t.write('\x1b]9;build done\x07\x1b]777;notify;Tests;all green\x07\x1b]633;E;ls\x07');
    expect(notes).toEqual(['|build done', 'Tests|all green']);
    expect(unknown).toEqual(['633;E;ls']);
  });

  test('rings the bell only for a real BEL, not one that ends an OSC', async () => {
    const t = await openTerminal();
    let bells = 0;
    t.onBell(() => bells++);
    t.write('\x1b]133;A\x07\x1b]2;title\x07');
    expect(bells).toBe(0);
    t.write('\x07');
    expect(bells).toBe(1);
  });

  test('reports title changes from Ghostty', async () => {
    const t = await openTerminal();
    const titles: string[] = [];
    t.onTitleChange((title) => titles.push(title));
    t.write('\x1b]2;vim notes.md\x07\x1b]0;htop\x1b\\');
    expect(titles).toEqual(['vim notes.md', 'htop']);
  });

  test('denies OSC 52 writes unless the host allows them', async () => {
    const t = await openTerminal();
    const offered: string[] = [];
    t.write('\x1b]52;c;aGVsbG8=\x07');
    t.clipboardWriteHandler = (text) => {
      offered.push(text);
      return true;
    };
    t.write('\x1b]52;c;aGVsbG8=\x07');
    expect(offered).toEqual(['hello']);
  });

  test('reports mouse tracking and alternate-screen switches like xterm.js', async () => {
    const t = await openTerminal();
    const switches: string[] = [];
    t.buffer.onBufferChange((b) => switches.push(b.type));
    expect(t.modes.mouseTrackingMode).toBe('none');
    t.write('\x1b[?1000h');
    expect(t.modes.mouseTrackingMode).toBe('vt200');
    t.write('\x1b[?1049h');
    t.write('\x1b[?1049l');
    expect(switches).toEqual(['alternate', 'normal']);
  });
});
