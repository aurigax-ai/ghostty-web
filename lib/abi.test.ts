import { describe, expect, test } from 'vitest';
import { Ghostty } from './ghostty';

describe('Abi', () => {
  test('reads struct layouts from ghostty_type_json and refuses unknown fields', async () => {
    const { abi } = await Ghostty.load();
    expect(abi.offset('GhosttyGridRef', 'x')).toBeGreaterThan(0);
    expect(() => abi.offset('GhosttyGridRef', 'no_such_field')).toThrow(/no field/);
    expect(() => abi.enumValue('GhosttyTerminalOption', 'NO_SUCH_OPTION')).toThrow(/no value/);
  });

  test('delivers a callback from libghostty-vt into JavaScript, in stream order', async () => {
    const ghostty = await Ghostty.load();
    const { abi } = ghostty;
    const term = ghostty.createTerminal(80, 24);
    const kindOffset = abi.offset('GhosttyTerminalSemanticPrompt', 'kind');
    const exitOffset = abi.offset('GhosttyTerminalSemanticPrompt', 'exit_code');
    const seen: { kind: number; exit: number; cursorX: number }[] = [];
    const callback = abi.addCallback(['i32', 'i32', 'i32'], null, (_t, _u, event) => {
      const view = abi.view();
      seen.push({
        kind: view.getInt32(event + kindOffset, true),
        exit: view.getInt32(event + exitOffset, true),
        cursorX: term.cursorPosition().x,
      });
    });
    term.setOption('SEMANTIC_PROMPT', callback);
    term.write('\x1b]133;A\x07$ \x1b]133;B\x07true\r\n\x1b]133;C\x07\x1b]133;D;3\x07');
    const kinds = 'GhosttySemanticPromptKind';
    expect(seen.map((e) => e.kind)).toEqual([
      abi.enumValue(kinds, 'PROMPT_START'),
      abi.enumValue(kinds, 'INPUT_START'),
      abi.enumValue(kinds, 'OUTPUT_START'),
      abi.enumValue(kinds, 'COMMAND_END'),
    ]);
    expect(seen[1].cursorX).toBe(2);
    expect(seen[3].exit).toBe(3);
    term.free();
  });

  test('answers a device status report through the write_pty callback', async () => {
    const ghostty = await Ghostty.load();
    const term = ghostty.createTerminal(80, 24);
    term.write('ab\x1b[6n');
    expect(term.readResponse()).toBe('\x1b[1;3R');
    expect(term.hasResponse()).toBe(false);
    term.free();
  });
});
