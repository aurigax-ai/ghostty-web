/**
 * SearchAddon: find in the terminal's screen and scrollback, shaped like
 * xterm.js's @xterm/addon-search (findNext, findPrevious, clearDecorations,
 * onDidChangeResults). Matching is libghostty-vt's: case-insensitive for ASCII
 * letters. "Next" moves toward older output, as in Ghostty, and the result
 * index counts from the newest match.
 */

import { EventEmitter } from '../event-emitter';
import type { SearchMatch, TerminalSearch } from '../ghostty';
import type { IDisposable, IEvent, ITerminalAddon } from '../interfaces';
import type { SearchHighlight } from '../renderer';
import type { Terminal } from '../terminal';

export interface ISearchDecorationOptions {
  matchBackground?: string;
  activeMatchBackground?: string;
}

export interface ISearchOptions {
  /** Typing into the query: keep searching from the newest match. */
  incremental?: boolean;
  decorations?: ISearchDecorationOptions;
}

export interface ISearchResultChangeEvent {
  /** Index of the selected match, newest first, or -1 when none is selected. */
  resultIndex: number;
  resultCount: number;
}

const DEFAULT_MATCH = '#5c6266';
const DEFAULT_ACTIVE = '#538bb5';
/** Matches beyond this many (newest first) are counted but not highlighted. */
const HIGHLIGHT_LIMIT = 20_000;

export class SearchAddon implements ITerminalAddon {
  private terminal?: Terminal;
  private search: TerminalSearch | null = null;
  private searchedEngine: unknown = null;
  private needle = '';
  private decorations: ISearchDecorationOptions = {};
  private frame: number | null = null;
  private subscriptions: IDisposable[] = [];
  private readonly resultsEmitter = new EventEmitter<ISearchResultChangeEvent>();

  readonly onDidChangeResults: IEvent<ISearchResultChangeEvent> = this.resultsEmitter.event;

  activate(terminal: Terminal): void {
    this.terminal = terminal;
    this.subscriptions = [
      terminal.onWriteParsed(() => this.scheduleRefresh()),
      terminal.onResize(() => this.scheduleRefresh()),
      terminal.onScroll(() => this.paint()),
    ];
  }

  findNext(term: string, options?: ISearchOptions): boolean {
    return this.find(term, options, true);
  }

  findPrevious(term: string, options?: ISearchOptions): boolean {
    return this.find(term, options, false);
  }

  /** Stops searching and removes every highlight. */
  clearDecorations(): void {
    this.cancelRefresh();
    this.needle = '';
    this.search?.setNeedle('');
    this.terminal?.setSearchHighlights(null);
  }

  private engineSearch(): TerminalSearch | null {
    const engine = this.terminal?.wasmTerm;
    if (!engine) return null;
    if (this.search && this.searchedEngine === engine) return this.search;
    this.search?.free();
    this.search = engine.createSearch();
    this.searchedEngine = engine;
    this.needle = '';
    return this.search;
  }

  private find(term: string, options: ISearchOptions | undefined, older: boolean): boolean {
    const search = this.engineSearch();
    if (!search) return false;
    if (options?.decorations) this.decorations = options.decorations;
    if (!term) {
      this.clearDecorations();
      this.emitResults();
      return false;
    }
    const changed = term !== this.needle;
    if (changed) {
      this.needle = term;
      search.setNeedle(term);
    }
    search.run();
    const found = search.select(changed ? true : older);
    if (found) this.reveal(search.selected());
    this.paint();
    this.emitResults();
    return found;
  }

  /** Scrolls so the match is in view, centered, unless it already is. */
  private reveal(match: SearchMatch | null): void {
    const terminal = this.terminal;
    if (!terminal || !match) return;
    const scrollback = terminal.getScrollbackLength();
    const top = scrollback - Math.floor(terminal.getViewportY());
    if (match.startY >= top && match.endY < top + terminal.rows) return;
    terminal.scrollToLine(match.startY - Math.floor(terminal.rows / 2));
  }

  private scheduleRefresh(): void {
    if (!this.needle || this.frame !== null) return;
    this.frame = requestAnimationFrame(() => {
      this.frame = null;
      if (!this.needle || !this.search) return;
      this.search.run();
      this.paint();
      this.emitResults();
    });
  }

  private cancelRefresh(): void {
    if (this.frame !== null) cancelAnimationFrame(this.frame);
    this.frame = null;
  }

  /** Highlights the matches on the rows now in view. */
  private paint(): void {
    const terminal = this.terminal;
    const search = this.search;
    if (!terminal || !search || !this.needle) return;
    const cols = terminal.cols;
    const rows = terminal.rows;
    const top = terminal.getScrollbackLength() - Math.floor(terminal.getViewportY());
    const selected = search.selected();
    const highlights: SearchHighlight[] = [];
    const matches = search.matches();
    for (let i = 0; i < matches.length && i < HIGHLIGHT_LIMIT; i++) {
      const match = matches[i];
      if (match.endY < top || match.startY >= top + rows) continue;
      const active =
        selected !== null &&
        selected.startX === match.startX &&
        selected.startY === match.startY &&
        selected.endX === match.endX &&
        selected.endY === match.endY;
      for (let y = Math.max(match.startY, top); y <= Math.min(match.endY, top + rows - 1); y++) {
        highlights.push({
          row: y - top,
          start: y === match.startY ? match.startX : 0,
          end: y === match.endY ? match.endX : cols - 1,
          active,
        });
      }
    }
    terminal.setSearchHighlights(highlights, {
      match: this.decorations.matchBackground ?? DEFAULT_MATCH,
      active: this.decorations.activeMatchBackground ?? DEFAULT_ACTIVE,
    });
  }

  private emitResults(): void {
    const search = this.search;
    if (!search || !this.needle) {
      this.resultsEmitter.fire({ resultIndex: -1, resultCount: 0 });
      return;
    }
    this.resultsEmitter.fire({
      resultIndex: search.selectedIndex() ?? -1,
      resultCount: search.total(),
    });
  }

  dispose(): void {
    this.cancelRefresh();
    for (const sub of this.subscriptions) sub.dispose();
    this.subscriptions = [];
    this.terminal?.setSearchHighlights(null);
    this.search?.free();
    this.search = null;
    this.resultsEmitter.dispose();
    this.terminal = undefined;
  }
}
