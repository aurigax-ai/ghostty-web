import { afterEach, describe, expect, test } from 'vitest';
import type { Terminal } from './terminal';
import { createIsolatedTerminal } from './test-helpers';

describe('idle terminal', () => {
  let term: Terminal | null = null;
  let container: HTMLElement | null = null;

  afterEach(() => {
    term?.dispose();
    container?.remove();
  });

  test('a blinking cursor draws about one frame per blink, not a render loop', async () => {
    container = document.createElement('div');
    document.body.appendChild(container);
    term = await createIsolatedTerminal({
      cols: 40,
      rows: 10,
      renderer: 'canvas',
      cursorBlink: true,
    });
    term.open(container);
    term.write('$ ');
    term.focus();
    await new Promise((resolve) => setTimeout(resolve, 1000));
    let frames = 0;
    const render = term.renderer!.render.bind(term.renderer!);
    term.renderer!.render = (...args) => {
      frames++;
      render(...args);
    };
    await new Promise((resolve) => setTimeout(resolve, 1600));
    expect(frames).toBeGreaterThanOrEqual(2);
    expect(frames).toBeLessThanOrEqual(6);
  });
});

describe('focus', () => {
  test('an unfocused terminal does not blink and draws no frames while idle', async () => {
    const container = document.createElement('div');
    const outside = document.createElement('button');
    document.body.append(container, outside);
    const term = await createIsolatedTerminal({
      cols: 40,
      rows: 10,
      renderer: 'canvas',
      cursorBlink: true,
    });
    term.open(container);
    term.focus();
    await new Promise((resolve) => setTimeout(resolve, 50));
    outside.focus();
    await new Promise((resolve) => setTimeout(resolve, 300));
    let frames = 0;
    const render = term.renderer!.render.bind(term.renderer!);
    term.renderer!.render = (...args) => {
      frames++;
      render(...args);
    };
    await new Promise((resolve) => setTimeout(resolve, 1400));
    expect(frames).toBe(0);
    term.dispose();
    container.remove();
    outside.remove();
  });
});
