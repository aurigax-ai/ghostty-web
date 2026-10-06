/**
 * xterm.js-compatible marker on a buffer line, backed by a libghostty-vt
 * tracked grid reference so it follows its line through scrolling, reflow and
 * scrollback pruning.
 */

import { EventEmitter } from './event-emitter';
import type { TrackedRow } from './ghostty';
import type { IDisposable, IEvent } from './interfaces';

export interface IMarker extends IDisposable {
  readonly id: number;
  readonly isDisposed: boolean;
  /** The marker's absolute buffer line (scrollback first), or -1 once disposed. */
  readonly line: number;
  readonly onDispose: IEvent<void>;
}

let nextMarkerId = 1;

export class Marker implements IMarker {
  readonly id = nextMarkerId++;
  private disposed = false;
  private readonly disposeEmitter = new EventEmitter<void>();
  readonly onDispose: IEvent<void> = this.disposeEmitter.event;

  constructor(private readonly row: TrackedRow) {}

  get isDisposed(): boolean {
    return this.disposed;
  }

  get line(): number {
    if (this.disposed) return -1;
    const line = this.row.line();
    if (line === null) {
      this.dispose();
      return -1;
    }
    return line;
  }

  /** Disposes the marker if its line no longer exists. */
  refresh(): void {
    if (!this.disposed && this.row.line() === null) this.dispose();
  }

  dispose(): void {
    if (this.disposed) return;
    this.disposed = true;
    this.row.free();
    this.disposeEmitter.fire();
    this.disposeEmitter.dispose();
  }
}
