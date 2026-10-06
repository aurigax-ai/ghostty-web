import { afterEach, describe, expect, test } from 'vitest';
import type { Terminal } from './terminal';
import { createIsolatedTerminal } from './test-helpers';

describe('scrollbar', () => {
  let term: Terminal | null = null;
  let container: HTMLElement | null = null;

  afterEach(() => {
    term?.dispose();
    container?.remove();
    term = null;
    container = null;
  });

  test('clicking the top of the track scrolls to the oldest output', async () => {
    container = document.createElement('div');
    document.body.appendChild(container);
    term = await createIsolatedTerminal({ cols: 40, rows: 10, renderer: 'canvas' });
    term.open(container);
    for (let i = 0; i < 100; i++) term.write(`line ${i}\r\n`);
    const scrollback = term.getScrollbackLength();
    expect(scrollback).toBeGreaterThan(50);
    const canvas = container.querySelector('canvas')!;
    canvas.getBoundingClientRect = () =>
      ({ left: 0, top: 0, width: 400, height: 200, right: 400, bottom: 200 }) as DOMRect;
    canvas.dispatchEvent(
      new MouseEvent('mousedown', { clientX: 392, clientY: 5, bubbles: true, cancelable: true })
    );
    expect(term.getViewportY()).toBe(scrollback);
  });
});
