import { afterEach, describe, expect, test, vi } from 'vitest';
import type { Terminal } from './terminal';
import { createIsolatedTerminal } from './test-helpers';

// Happy DOM has no WebGL 2, so a canvas renderer stands in for the WebGL one.
vi.mock('./webgl-renderer', async () => {
  const { CanvasRenderer } = await import('./renderer');
  class WebglRenderer extends CanvasRenderer {
    onContextLost?: () => void;
  }
  return { WebglRenderer };
});

const wait = (ms: number) => new Promise((resolve) => setTimeout(resolve, ms));

describe('paused terminal', () => {
  let term: Terminal | null = null;
  let container: HTMLElement | null = null;

  afterEach(() => {
    term?.dispose();
    container?.remove();
    term = null;
    container = null;
  });

  async function open(renderer: 'webgl' | 'canvas'): Promise<Terminal> {
    container = document.createElement('div');
    document.body.appendChild(container);
    term = await createIsolatedTerminal({ cols: 40, rows: 5, renderer });
    term.open(container);
    await wait(50);
    return term;
  }

  function countDraws(t: Terminal): boolean[] {
    const draws: boolean[] = [];
    const renderer = t.renderer!;
    const render = renderer.render.bind(renderer);
    renderer.render = (buffer, forceAll, ...rest) => {
      draws.push(forceAll ?? false);
      render(buffer, forceAll, ...rest);
    };
    return draws;
  }

  test('parses output but draws no frames and fires no onRender while paused', async () => {
    const t = await open('canvas');
    const draws = countDraws(t);
    let renders = 0;
    t.onRender(() => renders++);
    const frames = vi.spyOn(window, 'requestAnimationFrame');
    try {
      t.setPaused(true);
      t.write('hidden output\r\n');
      t.input('typed', true);
      t.write('echo');
      t.scrollLines(-1);
      await wait(200);
      expect(frames).not.toHaveBeenCalled();
    } finally {
      frames.mockRestore();
    }
    expect(draws).toEqual([]);
    expect(renders).toBe(0);
    expect(t.buffer.active.getLine(0)?.translateToString(true)).toBe('hidden output');
  });

  test('redraws the whole screen once on resume', async () => {
    const t = await open('canvas');
    t.setPaused(true);
    t.write('while hidden');
    const draws = countDraws(t);
    let renders = 0;
    t.onRender(() => renders++);
    t.setPaused(false);
    expect(draws).toEqual([true]);
    expect(renders).toBe(1);
    expect(t.buffer.active.getLine(0)?.translateToString(true)).toBe('while hidden');
  });

  test('releases the WebGL renderer while paused and makes a new one on resume', async () => {
    const t = await open('webgl');
    const webgl = t.renderer!;
    expect(t.rendererType).toBe('webgl');
    const disposed = vi.spyOn(webgl, 'dispose');
    t.setPaused(true, { releaseRenderer: true });
    expect(disposed).toHaveBeenCalledOnce();
    expect(t.rendererType).toBe('canvas');
    t.write('while released');
    t.setPaused(false);
    expect(t.rendererType).toBe('webgl');
    expect(t.renderer).not.toBe(webgl);
    expect(t.buffer.active.getLine(0)?.translateToString(true)).toBe('while released');
  });
});
