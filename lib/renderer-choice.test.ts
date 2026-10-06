import { afterEach, describe, expect, test } from 'vitest';
import type { Terminal } from './terminal';
import { createIsolatedTerminal } from './test-helpers';

describe('renderer choice', () => {
  let term: Terminal | null = null;
  let container: HTMLElement | null = null;

  afterEach(() => {
    term?.dispose();
    container?.remove();
    term = null;
    container = null;
  });

  async function open(renderer?: 'webgl' | 'canvas'): Promise<Terminal> {
    container = document.createElement('div');
    document.body.appendChild(container);
    term = await createIsolatedTerminal(renderer ? { renderer } : {});
    term.open(container);
    return term;
  }

  test('draws with canvas when asked to', async () => {
    const t = await open('canvas');
    expect(t.rendererType).toBe('canvas');
    expect(container!.querySelectorAll('canvas')).toHaveLength(1);
  });

  test('falls back to canvas on the same element when WebGL 2 is unavailable', async () => {
    const t = await open('webgl');
    expect(t.rendererType).toBe('canvas');
    expect(container!.querySelectorAll('canvas')).toHaveLength(1);
    t.write('still drawing');
    expect(t.buffer.active.getLine(0)?.translateToString(true)).toBe('still drawing');
  });

  test('asks for WebGL by default', async () => {
    const t = await open();
    expect(t.options.renderer).toBe('webgl');
  });
});
