/**
 * Terminal - Main terminal emulator class
 *
 * Provides an xterm.js-compatible API wrapping Ghostty's WASM terminal emulator.
 *
 * Usage:
 * ```typescript
 * import { init, Terminal } from 'ghostty-web';
 *
 * await init();
 * const term = new Terminal();
 * term.open(document.getElementById('container'));
 * term.write('Hello, World!\n');
 * term.onData(data => console.log('User typed:', data));
 * ```
 */

import { BufferNamespace } from './buffer';
import { EventEmitter } from './event-emitter';
import {
  type DesktopNotificationEvent,
  DirtyState,
  type Ghostty,
  type GhosttyCell,
  type GhosttyTerminal,
  type GhosttyTerminalConfig,
  type MouseTrackingMode,
  type SemanticPromptEvent,
} from './ghostty';
import { getGhostty } from './index';
import { InputHandler, type MouseTrackingConfig } from './input-handler';
import type {
  FontWeight,
  IBufferNamespace,
  IBufferRange,
  IDisposable,
  IEvent,
  IKeyEvent,
  ITerminalAddon,
  ITerminalCore,
  ITerminalOptions,
  IUnicodeVersionProvider,
} from './interfaces';
import { LinkDetector } from './link-detector';
import { type IMarker, Marker } from './marker';
import { OSC8LinkProvider } from './providers/osc8-link-provider';
import { UrlRegexProvider } from './providers/url-regex-provider';
import {
  CanvasRenderer,
  type RendererOptions,
  type SearchHighlight,
  type SearchHighlightColors,
  type TerminalRenderer,
} from './renderer';
import { SelectionManager } from './selection-manager';
import type { ILink, ILinkProvider } from './types';
import { WebglRenderer } from './webgl-renderer';

// ============================================================================
// Terminal Class
// ============================================================================

export class Terminal implements ITerminalCore {
  // Public properties (xterm.js compatibility)
  public cols: number;
  public rows: number;
  public element?: HTMLElement;
  public textarea?: HTMLTextAreaElement;

  // Buffer API (xterm.js compatibility)
  public readonly buffer: IBufferNamespace;

  // Unicode API (xterm.js compatibility)
  public readonly unicode: IUnicodeVersionProvider = {
    get activeVersion(): string {
      return '15.1'; // Ghostty supports Unicode 15.1
    },
  };

  // Options (public for xterm.js compatibility)
  public readonly options!: Required<ITerminalOptions>;

  // Components (created on open())
  private ghostty?: Ghostty;
  public wasmTerm?: GhosttyTerminal; // Made public for link providers
  public renderer?: TerminalRenderer; // Made public for FitAddon
  private inputHandler?: InputHandler;
  private selectionManager?: SelectionManager;
  private canvas?: HTMLCanvasElement;

  // Link detection system
  private linkDetector?: LinkDetector;
  private currentHoveredLink?: ILink;
  private mouseMoveThrottleTimeout?: number;
  private pendingMouseMove?: MouseEvent;

  // Event emitters
  private dataEmitter = new EventEmitter<string>();
  private resizeEmitter = new EventEmitter<{ cols: number; rows: number }>();
  private bellEmitter = new EventEmitter<void>();
  private selectionChangeEmitter = new EventEmitter<void>();
  private keyEmitter = new EventEmitter<IKeyEvent>();
  private titleChangeEmitter = new EventEmitter<string>();
  private scrollEmitter = new EventEmitter<number>();
  private renderEmitter = new EventEmitter<{ start: number; end: number }>();
  private cursorMoveEmitter = new EventEmitter<void>();
  private writeParsedEmitter = new EventEmitter<void>();
  // Public event accessors (xterm.js compatibility)
  public readonly onData: IEvent<string> = this.dataEmitter.event;
  public readonly onResize: IEvent<{ cols: number; rows: number }> = this.resizeEmitter.event;
  public readonly onBell: IEvent<void> = this.bellEmitter.event;
  public readonly onSelectionChange: IEvent<void> = this.selectionChangeEmitter.event;
  public readonly onKey: IEvent<IKeyEvent> = this.keyEmitter.event;
  public readonly onTitleChange: IEvent<string> = this.titleChangeEmitter.event;
  public readonly onScroll: IEvent<number> = this.scrollEmitter.event;
  public readonly onRender: IEvent<{ start: number; end: number }> = this.renderEmitter.event;
  public readonly onCursorMove: IEvent<void> = this.cursorMoveEmitter.event;
  /** Fires after written data was parsed, as xterm.js's onWriteParsed. */
  public readonly onWriteParsed: IEvent<void> = this.writeParsedEmitter.event;

  private pwdEmitter = new EventEmitter<string>();
  private semanticPromptEmitter = new EventEmitter<SemanticPromptEvent>();
  private desktopNotificationEmitter = new EventEmitter<DesktopNotificationEvent>();
  private unknownOscEmitter = new EventEmitter<string>();

  /** OSC 7 working directory as the shell sent it (raw file:// URI with its host). */
  public readonly onPwdChange: IEvent<string> = this.pwdEmitter.event;
  /** OSC 133 prompt marks; buffer.active cursor reads inside the handler are exact. */
  public readonly onSemanticPrompt: IEvent<SemanticPromptEvent> = this.semanticPromptEmitter.event;
  /** OSC 9 / OSC 777 desktop notifications. */
  public readonly onDesktopNotification: IEvent<DesktopNotificationEvent> =
    this.desktopNotificationEmitter.event;
  /** OSCs libghostty-vt does not implement, as their content (e.g. `633;E;ls`). */
  public readonly onUnknownOsc: IEvent<string> = this.unknownOscEmitter.event;

  /**
   * Whether replies to the program's queries (DSR, DA, mode and color reports)
   * are sent back as data. A host that runs the shell behind a multiplexer which
   * answers them itself turns this off.
   */
  public answerQueries = true;

  private engineSubscriptions: IDisposable[] = [];
  private clipboardHandler: ((text: string) => boolean) | null = null;
  private markers = new Set<Marker>();
  private lastAlternate = false;
  private idleFrames = 0;
  private static readonly IDLE_FRAMES_BEFORE_SLEEP = 30;

  // Lifecycle state
  private isOpen = false;
  private isDisposed = false;
  private animationFrameId?: number;
  private writeQueue: Uint8Array[] = [];
  private awaitingEcho = false;

  // Addons
  private addons: ITerminalAddon[] = [];

  // Phase 1: Custom event handlers
  private customKeyEventHandler?: (event: KeyboardEvent) => boolean;

  // Phase 1: Title tracking
  private currentTitle: string = '';

  // Phase 2: Viewport and scrolling state
  public viewportY: number = 0; // Top line of viewport in scrollback buffer (0 = at bottom, can be fractional during smooth scroll)
  private targetViewportY: number = 0; // Target viewport position for smooth scrolling
  private scrollAnimationStartTime?: number;
  private scrollAnimationFrame?: number;
  private customWheelEventHandler?: (event: WheelEvent) => boolean;
  private lastCursorY: number = 0; // Track cursor position for onCursorMove

  // Scrollbar interaction state
  private isDraggingScrollbar: boolean = false;
  private scrollbarDragStart: number | null = null;
  private scrollbarDragStartViewportY: number = 0;

  // Scrollbar visibility/auto-hide state
  private scrollbarVisible: boolean = false;
  private scrollbarOpacity: number = 0;
  private scrollbarHideTimeout?: number;
  private readonly SCROLLBAR_HIDE_DELAY_MS = 1500; // Hide after 1.5 seconds
  private readonly SCROLLBAR_FADE_DURATION_MS = 200; // 200ms fade animation

  constructor(options: ITerminalOptions = {}) {
    // Use provided Ghostty instance (for test isolation) or get module-level instance
    this.ghostty = options.ghostty ?? getGhostty();

    // Create base options object with all defaults (excluding ghostty)
    const baseOptions = {
      cols: options.cols ?? 80,
      rows: options.rows ?? 24,
      cursorBlink: options.cursorBlink ?? false,
      cursorStyle: options.cursorStyle ?? 'block',
      theme: options.theme ?? {},
      scrollback: options.scrollback ?? 10000,
      fontSize: options.fontSize ?? 15,
      fontFamily: options.fontFamily ?? 'monospace',
      allowTransparency: options.allowTransparency ?? false,
      linkHandler: options.linkHandler ?? null,
      renderer: options.renderer ?? 'webgl',
      convertEol: options.convertEol ?? false,
      disableStdin: options.disableStdin ?? false,
      smoothScrollDuration: options.smoothScrollDuration ?? 100, // Default: 100ms smooth scroll
      fontWeight: options.fontWeight ?? 'normal',
      fontWeightBold: options.fontWeightBold ?? 'bold',
      lineHeight: options.lineHeight ?? 1,
      scrollSensitivity: options.scrollSensitivity ?? 1,
      minimumContrastRatio: options.minimumContrastRatio ?? 1,
      macOptionIsMeta: options.macOptionIsMeta ?? false,
    };

    // Wrap in Proxy to intercept runtime changes (xterm.js compatibility)
    (this.options as any) = new Proxy(baseOptions, {
      set: (target: any, prop: string, value: any) => {
        const oldValue = target[prop];
        target[prop] = value;

        // Apply runtime changes if terminal is open
        if (this.isOpen) {
          this.handleOptionChange(prop, value, oldValue);
        }

        return true;
      },
    });

    this.cols = this.options.cols;
    this.rows = this.options.rows;

    // Initialize buffer API
    this.buffer = new BufferNamespace(this);
  }

  // ==========================================================================
  // Option Change Handling (for mutable options)
  // ==========================================================================

  /**
   * Handle runtime option changes (called when options are modified after terminal is open)
   * This enables xterm.js compatibility where options can be changed at runtime
   */
  private handleOptionChange(key: string, newValue: any, oldValue: any): void {
    this.wake();
    if (newValue === oldValue) return;

    switch (key) {
      case 'disableStdin':
        // Input handler already checks this.options.disableStdin dynamically
        // No action needed
        break;

      case 'cursorBlink':
      case 'cursorStyle':
        if (this.renderer) {
          this.renderer.setCursorStyle(this.options.cursorStyle);
          this.renderer.setCursorBlink(this.options.cursorBlink);
        }
        break;

      case 'theme':
        this.wasmTerm?.configure(this.themeConfig());
        if (this.renderer && this.wasmTerm) {
          this.renderer.setTheme(this.options.theme);
          this.renderer.render(this.wasmTerm, true, this.viewportY, this, this.scrollbarOpacity);
        }
        break;

      case 'macOptionIsMeta':
        if (this.inputHandler) this.inputHandler.macOptionIsMeta = this.options.macOptionIsMeta;
        break;

      case 'fontWeight':
      case 'fontWeightBold':
      case 'lineHeight':
        if (this.renderer) {
          this.renderer.setFontOptions(this.fontOptions());
          this.handleFontChange();
        }
        break;

      case 'minimumContrastRatio':
        if (this.renderer && this.wasmTerm) {
          this.renderer.setMinimumContrastRatio(this.options.minimumContrastRatio);
          this.renderer.render(this.wasmTerm, true, this.viewportY, this, this.scrollbarOpacity);
        }
        break;

      case 'scrollback':
        this.wasmTerm?.configure({ scrollbackLimit: this.options.scrollback });
        break;

      case 'fontSize':
        if (this.renderer) {
          this.renderer.setFontSize(this.options.fontSize);
          this.handleFontChange();
        }
        break;

      case 'fontFamily':
        if (this.renderer) {
          this.renderer.setFontFamily(this.options.fontFamily);
          this.handleFontChange();
        }
        break;

      case 'cols':
      case 'rows':
        // Redirect to resize method
        this.resize(this.options.cols, this.options.rows);
        break;
    }
  }

  /**
   * Handle font changes (fontSize or fontFamily)
   * Updates canvas size to match new font metrics and forces a full re-render
   */
  private handleFontChange(): void {
    if (!this.renderer || !this.wasmTerm || !this.canvas) return;

    // Clear any active selection since pixel positions have changed
    if (this.selectionManager) {
      this.selectionManager.clearSelection();
    }

    // Resize canvas to match new font metrics
    this.renderer.resize(this.cols, this.rows);

    // Force full re-render with new font
    this.renderer.render(this.wasmTerm, true, this.viewportY, this);
  }

  /**
   * Parse a CSS color string to 0xRRGGBB format.
   * Returns 0 if the color is undefined or invalid.
   */
  private parseColorToHex(color?: string): number | undefined {
    if (!color) return undefined;
    if (color.startsWith('#')) {
      let hex = color.slice(1);
      if (hex.length === 3 || hex.length === 4) {
        hex = hex[0] + hex[0] + hex[1] + hex[1] + hex[2] + hex[2];
      }
      const value = Number.parseInt(hex.slice(0, 6), 16);
      return hex.length >= 6 && !Number.isNaN(value) ? value : undefined;
    }
    const match = color.match(/rgba?\((\d+),\s*(\d+),\s*(\d+)/);
    if (match) {
      const r = Number.parseInt(match[1], 10);
      const g = Number.parseInt(match[2], 10);
      const b = Number.parseInt(match[3], 10);
      return (r << 16) | (g << 8) | b;
    }
    return undefined;
  }

  /** Theme colors in the form libghostty-vt takes; a color the theme leaves out keeps Ghostty's default. */
  private themeConfig(): GhosttyTerminalConfig {
    const theme = this.options.theme;
    const palette = [
      theme?.black,
      theme?.red,
      theme?.green,
      theme?.yellow,
      theme?.blue,
      theme?.magenta,
      theme?.cyan,
      theme?.white,
      theme?.brightBlack,
      theme?.brightRed,
      theme?.brightGreen,
      theme?.brightYellow,
      theme?.brightBlue,
      theme?.brightMagenta,
      theme?.brightCyan,
      theme?.brightWhite,
    ].map((color) => this.parseColorToHex(color));
    return {
      fgColor: this.parseColorToHex(theme?.foreground),
      bgColor: this.parseColorToHex(theme?.background),
      cursorColor: this.parseColorToHex(theme?.cursor),
      palette,
    };
  }

  private buildWasmConfig(): GhosttyTerminalConfig {
    return { ...this.themeConfig(), scrollbackLimit: this.options.scrollback };
  }

  // ==========================================================================
  // Lifecycle Methods
  // ==========================================================================

  /**
   * Open terminal in a parent element
   *
   * Initializes all components and starts rendering.
   * Requires a pre-loaded Ghostty instance passed to the constructor.
   */
  open(parent: HTMLElement): void {
    if (this.isOpen) {
      throw new Error('Terminal is already open');
    }
    if (this.isDisposed) {
      throw new Error('Terminal has been disposed');
    }

    // Store parent element
    this.element = parent;
    this.isOpen = true;

    try {
      // Make parent focusable if it isn't already
      if (!parent.hasAttribute('tabindex')) {
        parent.setAttribute('tabindex', '0');
      }

      // Mark as contenteditable so browser extensions (Vimium, etc.) recognize
      // this as an input element and don't intercept keyboard events.
      parent.setAttribute('contenteditable', 'true');
      // Prevent actual content editing - we handle input ourselves
      parent.addEventListener('beforeinput', (e) => {
        if (e.target === parent) {
          e.preventDefault();
        }
      });

      // Add accessibility attributes for screen readers and extensions
      parent.setAttribute('role', 'textbox');
      parent.setAttribute('aria-label', 'Terminal input');
      parent.setAttribute('aria-multiline', 'true');

      // Create WASM terminal with current dimensions and config
      const config = this.buildWasmConfig();
      this.wasmTerm = this.ghostty!.createTerminal(this.cols, this.rows, config);
      this.wireEngine();

      // Create canvas element
      this.canvas = document.createElement('canvas');
      this.canvas.style.display = 'block';
      this.canvas.style.cursor = 'text';

      parent.appendChild(this.canvas);

      // Create hidden textarea for keyboard input (must be inside parent for event bubbling)
      this.textarea = document.createElement('textarea');
      this.textarea.setAttribute('autocorrect', 'off');
      this.textarea.setAttribute('autocapitalize', 'off');
      this.textarea.setAttribute('spellcheck', 'false');
      this.textarea.setAttribute('tabindex', '0'); // Allow focus for mobile keyboard
      this.textarea.setAttribute('aria-label', 'Terminal input');
      // Use clip-path to completely hide the textarea and its caret
      this.textarea.style.position = 'absolute';
      this.textarea.style.left = '0';
      this.textarea.style.top = '0';
      this.textarea.style.width = '1px';
      this.textarea.style.height = '1px';
      this.textarea.style.padding = '0';
      this.textarea.style.border = 'none';
      this.textarea.style.margin = '0';
      this.textarea.style.opacity = '0';
      this.textarea.style.clipPath = 'inset(50%)'; // Clip everything including caret
      this.textarea.style.overflow = 'hidden';
      this.textarea.style.whiteSpace = 'nowrap';
      this.textarea.style.resize = 'none';
      parent.appendChild(this.textarea);

      // Focus textarea on interaction - preventDefault before focus
      const textarea = this.textarea;
      // Desktop: mousedown
      this.canvas.addEventListener('mousedown', (ev) => {
        ev.preventDefault();
        textarea.focus();
      });
      // Mobile: touchend with preventDefault to suppress iOS caret
      this.canvas.addEventListener('touchend', (ev) => {
        ev.preventDefault();
        textarea.focus();
      });

      this.renderer = this.createRenderer();
      this.renderer.resize(this.cols, this.rows);

      // Create mouse tracking configuration
      const canvas = this.canvas;
      const wasmTerm = this.wasmTerm;
      const mouseConfig: MouseTrackingConfig = {
        hasMouseTracking: () => wasmTerm?.hasMouseTracking() ?? false,
        hasSgrMouseMode: () => wasmTerm?.getMode(1006, false) ?? true, // SGR extended mode
        getCellDimensions: () => ({
          width: this.renderer!.charWidth,
          height: this.renderer!.charHeight,
        }),
        getCanvasOffset: () => {
          const rect = canvas.getBoundingClientRect();
          return { left: rect.left, top: rect.top };
        },
      };

      // Create input handler
      this.inputHandler = new InputHandler(
        this.ghostty!,
        parent,
        (data: string) => {
          // Check if stdin is disabled
          if (this.options.disableStdin) {
            return;
          }
          // Clear selection when user types
          this.selectionManager?.clearSelection();
          this.awaitingEcho = true;
          // Input handler fires data events
          this.dataEmitter.fire(data);
        },
        () => {
          // Input handler can also fire bell
          this.bellEmitter.fire();
        },
        (keyEvent: IKeyEvent) => {
          // Forward key events
          this.keyEmitter.fire(keyEvent);
        },
        this.customKeyEventHandler,
        (mode: number) => {
          // Query terminal mode state (e.g., mode 1 for application cursor mode)
          return this.wasmTerm?.getMode(mode, false) ?? false;
        },
        () => {
          // Handle Cmd+C copy - returns true if there was a selection to copy
          return this.copySelection();
        },
        this.textarea,
        mouseConfig
      );
      this.inputHandler.macOptionIsMeta = this.options.macOptionIsMeta;

      // Create selection manager (pass textarea for context menu positioning)
      this.selectionManager = new SelectionManager(
        this,
        this.renderer,
        this.wasmTerm,
        this.textarea
      );

      // Connect selection manager to renderer
      this.renderer.setSelectionManager(this.selectionManager);

      // Forward selection change events
      this.selectionManager.onSelectionChange(() => {
        this.selectionChangeEmitter.fire();
      });

      // Initialize link detection system
      this.linkDetector = new LinkDetector(this);

      // Register link providers
      // OSC8 first (explicit hyperlinks take precedence)
      this.linkDetector.registerProvider(new OSC8LinkProvider(this));
      // URL regex second (fallback for plain text URLs)
      this.linkDetector.registerProvider(new UrlRegexProvider(this));

      // Setup mouse event handling for links and scrollbar
      // Use capture phase to intercept scrollbar clicks before SelectionManager
      parent.addEventListener('mousedown', this.handleMouseDown, { capture: true });
      parent.addEventListener('mousemove', this.handleMouseMove);
      parent.addEventListener('mouseleave', this.handleMouseLeave);
      parent.addEventListener('focusin', this.handleFocusIn);
      parent.addEventListener('focusout', this.handleFocusOut);
      parent.addEventListener('click', this.handleClick);

      // Setup document-level mouseup for scrollbar drag (so drag works even outside canvas)
      document.addEventListener('mouseup', this.handleMouseUp);

      // Setup wheel event handling for scrolling (Phase 2)
      // Use capture phase to ensure we get the event before browser scrolling
      parent.addEventListener('wheel', this.handleWheel, { passive: false, capture: true });

      // Render initial blank screen (force full redraw)
      this.renderer.render(this.wasmTerm, true, this.viewportY, this, this.scrollbarOpacity);

      // Start render loop
      this.startRenderLoop();
    } catch (error) {
      // Clean up on error
      this.isOpen = false;
      this.cleanupComponents();
      throw new Error(`Failed to open terminal: ${error}`);
    }
  }

  /** Which renderer draws the terminal now: 'webgl', or 'canvas' when asked for or fallen back to. */
  get rendererType(): 'webgl' | 'canvas' {
    return this.renderer instanceof WebglRenderer ? 'webgl' : 'canvas';
  }

  private fontOptions(): {
    fontWeight: FontWeight;
    fontWeightBold: FontWeight;
    lineHeight: number;
  } {
    return {
      fontWeight: this.options.fontWeight,
      fontWeightBold: this.options.fontWeightBold,
      lineHeight: this.options.lineHeight,
    };
  }

  private rendererOptions(): RendererOptions {
    return {
      ...this.fontOptions(),
      minimumContrastRatio: this.options.minimumContrastRatio,
      fontSize: this.options.fontSize,
      fontFamily: this.options.fontFamily,
      cursorStyle: this.options.cursorStyle,
      cursorBlink: this.options.cursorBlink,
      theme: this.options.theme,
    };
  }

  private createRenderer(): TerminalRenderer {
    let renderer: TerminalRenderer | null = null;
    if (this.options.renderer === 'webgl') {
      try {
        const webgl = new WebglRenderer(this.canvas!, this.rendererOptions());
        webgl.onContextLost = () => this.fallBackToCanvas();
        renderer = webgl;
      } catch {
        renderer = null;
      }
    }
    renderer ??= new CanvasRenderer(this.canvas!, this.rendererOptions());
    renderer.onNeedsFrame = () => this.requestFrame();
    renderer.setFocused(this.focused);
    return renderer;
  }

  /** Replaces a WebGL renderer whose context was lost with a canvas renderer on the same canvas. */
  private fallBackToCanvas(): void {
    if (!this.renderer || !this.canvas || !(this.renderer instanceof WebglRenderer)) return;
    const hoveredLink = this.renderer.getHoveredHyperlinkId();
    this.renderer.dispose();
    const renderer = new CanvasRenderer(this.canvas, this.rendererOptions());
    renderer.onNeedsFrame = () => this.requestFrame();
    renderer.setHoveredHyperlinkId(hoveredLink);
    renderer.setFocused(this.focused);
    renderer.setSearchHighlights(this.searchHighlights.list, this.searchHighlights.colors);
    if (this.selectionManager) {
      renderer.setSelectionManager(this.selectionManager);
      this.selectionManager.setRenderer(renderer);
    }
    this.renderer = renderer;
    renderer.resize(this.cols, this.rows);
    if (this.wasmTerm) {
      renderer.render(this.wasmTerm, true, this.viewportY, this, this.scrollbarOpacity);
    }
    this.wake();
  }

  /**
   * Write data to terminal
   */
  write(data: string | Uint8Array, callback?: () => void): void {
    this.assertOpen();

    // Handle convertEol option
    if (this.options.convertEol && typeof data === 'string') {
      data = data.replace(/\n/g, '\r\n');
    }

    this.writeInternal(data, callback);
  }

  /**
   * Internal write implementation (extracted from write())
   */
  private writeInternal(data: string | Uint8Array, callback?: () => void): void {
    // Note: We intentionally do NOT clear selection on write - most modern terminals
    // preserve selection when new data arrives. Selection is cleared by user actions
    // like clicking or typing, not by incoming data.

    // Write directly to WASM terminal (handles VT parsing internally)
    this.wasmTerm!.write(data);

    // Process any responses generated by the terminal (e.g., DSR cursor position)
    // These need to be sent back to the PTY via onData
    this.processTerminalResponses();

    // Invalidate link cache (content changed)
    this.linkDetector?.invalidateCache();

    // Phase 2: Auto-scroll to bottom on new output (xterm.js behavior)
    if (this.viewportY !== 0) {
      this.scrollToBottom();
    }

    this.afterWrite();

    // Call callback if provided
    if (callback) {
      // The data is parsed by now, so run the callback as soon as this task
      // ends, as xterm.js does once a write is processed.
      queueMicrotask(callback);
    }

    if (this.awaitingEcho) {
      this.awaitingEcho = false;
      if (this.renderer && this.wasmTerm) {
        this.renderer.render(this.wasmTerm, false, this.viewportY, this, this.scrollbarOpacity);
      }
    }

    // Render will happen on next animation frame
  }

  /**
   * Write data with newline
   */
  writeln(data: string | Uint8Array, callback?: () => void): void {
    if (typeof data === 'string') {
      this.write(data + '\r\n', callback);
    } else {
      // Append \r\n to Uint8Array
      const newData = new Uint8Array(data.length + 2);
      newData.set(data);
      newData[data.length] = 0x0d; // \r
      newData[data.length + 1] = 0x0a; // \n
      this.write(newData, callback);
    }
  }

  /**
   * Paste text into terminal (triggers bracketed paste if supported)
   */
  paste(data: string): void {
    this.assertOpen();

    // Don't paste if stdin is disabled
    if (this.options.disableStdin) {
      return;
    }

    this.awaitingEcho = true;

    // Check if terminal has bracketed paste mode enabled
    if (this.wasmTerm!.hasBracketedPaste()) {
      // Wrap with bracketed paste sequences (DEC mode 2004)
      this.dataEmitter.fire('\x1b[200~' + data + '\x1b[201~');
    } else {
      // Send data directly
      this.dataEmitter.fire(data);
    }
  }

  /**
   * Input data into terminal (as if typed by user)
   *
   * @param data - Data to input
   * @param wasUserInput - If true, triggers onData event (default: false for compat with some apps)
   */
  input(data: string, wasUserInput: boolean = false): void {
    this.assertOpen();

    // Don't input if stdin is disabled
    if (this.options.disableStdin) {
      return;
    }

    if (wasUserInput) {
      this.awaitingEcho = true;
      // Trigger onData event as if user typed it
      this.dataEmitter.fire(data);
    } else {
      // Just write to terminal without triggering onData
      this.write(data);
    }
  }

  /**
   * Resize terminal
   */
  resize(cols: number, rows: number): void {
    this.assertOpen();

    if (cols === this.cols && rows === this.rows) {
      return; // No change
    }

    // Cancel render loop before resize to prevent accessing detached TypedArray
    // views while WASM reallocates buffers. We restart it after resize completes.
    // This avoids the background-tab regression of using an isResizing flag
    // cleared via requestAnimationFrame (rAF is throttled/paused in background tabs).
    this.cancelRenderLoop();

    try {
      // Update dimensions
      this.cols = cols;
      this.rows = rows;

      // Resize WASM terminal (may reallocate buffers, invalidating TypedArray views)
      this.wasmTerm!.resize(cols, rows);
      this.refreshMarkers(false);

      // Resize renderer
      this.renderer!.resize(cols, rows);

      // Fire resize event
      this.resizeEmitter.fire({ cols, rows });

      // Force full render
      this.renderer!.render(this.wasmTerm!, true, this.viewportY, this);
    } catch (e) {
      console.error('Terminal resize failed:', e);
    }

    // Flush any writes that were queued during resize, then restart render loop
    this.flushWriteQueue();
    this.wake();
  }

  /**
   * Clear terminal screen
   */
  clear(): void {
    this.assertOpen();
    // Send ANSI clear screen and cursor home sequences
    this.wasmTerm!.write('\x1b[2J\x1b[H');
  }

  /**
   * Reset terminal state
   */
  reset(): void {
    this.assertOpen();

    // Free old WASM terminal and create new one
    if (this.wasmTerm) {
      this.wasmTerm.free();
    }
    const config = this.buildWasmConfig();
    this.disposeMarkers();
    this.wasmTerm = this.ghostty!.createTerminal(this.cols, this.rows, config);
    this.wireEngine();
    this.wake();

    // Clear renderer
    this.renderer!.clear();

    // Reset title
    this.currentTitle = '';
  }

  /**
   * Focus terminal input
   */
  focus(): void {
    this.wake();
    if (this.isOpen && this.element) this.element.focus();
  }

  /**
   * Blur terminal (remove focus)
   */
  blur(): void {
    this.wake();
    if (this.isOpen && this.element) {
      this.element.blur();
    }
  }

  /**
   * Load an addon
   */
  loadAddon(addon: ITerminalAddon): void {
    addon.activate(this);
    this.addons.push(addon);
  }

  // ==========================================================================
  // Selection API (xterm.js compatible)
  // ==========================================================================

  /**
   * Get the selected text as a string
   */
  public getSelection(): string {
    return this.selectionManager?.getSelection() || '';
  }

  /**
   * Check if there's an active selection
   */
  public hasSelection(): boolean {
    return this.selectionManager?.hasSelection() || false;
  }

  /**
   * Clear the current selection
   */
  public clearSelection(): void {
    this.selectionManager?.clearSelection();
  }

  /**
   * Copy the current selection to clipboard
   * @returns true if there was text to copy, false otherwise
   */
  public copySelection(): boolean {
    return this.selectionManager?.copySelection() || false;
  }

  /**
   * Select all text in the terminal
   */
  public selectAll(): void {
    this.selectionManager?.selectAll();
  }

  /**
   * Select text at specific column and row with length
   */
  public select(column: number, row: number, length: number): void {
    this.selectionManager?.select(column, row, length);
  }

  /**
   * Select entire lines from start to end
   */
  public selectLines(start: number, end: number): void {
    this.selectionManager?.selectLines(start, end);
  }

  /**
   * Get selection position as buffer range
   */
  /**
   * Get the current viewport Y position.
   *
   * This is the number of lines scrolled back from the bottom of the
   * scrollback buffer. It may be fractional during smooth scrolling.
   */
  public getViewportY(): number {
    return this.viewportY;
  }

  public getSelectionPosition(): IBufferRange | undefined {
    return this.selectionManager?.getSelectionPosition();
  }

  // ==========================================================================
  // Phase 1: Custom Event Handlers
  // ==========================================================================

  /**
   * Attach a custom keyboard event handler
   * Returns true to prevent default handling
   */
  public attachCustomKeyEventHandler(
    customKeyEventHandler: (event: KeyboardEvent) => boolean
  ): void {
    this.customKeyEventHandler = customKeyEventHandler;
    // Update input handler if already created
    if (this.inputHandler) {
      this.inputHandler.setCustomKeyEventHandler(customKeyEventHandler);
    }
  }

  /**
   * Attach a custom wheel event handler (Phase 2)
   * Returns true to prevent default handling
   */
  public attachCustomWheelEventHandler(
    customWheelEventHandler?: (event: WheelEvent) => boolean
  ): void {
    this.customWheelEventHandler = customWheelEventHandler;
  }

  // ==========================================================================
  // Link Detection Methods
  // ==========================================================================

  /**
   * Register a custom link provider
   * Multiple providers can be registered to detect different types of links
   *
   * @example
   * ```typescript
   * term.registerLinkProvider({
   *   provideLinks(y, callback) {
   *     // Detect URLs, file paths, etc.
   *     callback(detectedLinks);
   *   }
   * });
   * ```
   */
  public registerLinkProvider(provider: ILinkProvider): void {
    if (!this.linkDetector) {
      throw new Error('Terminal must be opened before registering link providers');
    }
    this.linkDetector.registerProvider(provider);
  }

  // ==========================================================================
  // Phase 2: Scrolling Methods
  // ==========================================================================

  /**
   * Scroll viewport by a number of lines
   * @param amount Number of lines to scroll (positive = down, negative = up)
   */
  public scrollLines(amount: number): void {
    this.wake();
    if (!this.wasmTerm) {
      throw new Error('Terminal not open');
    }

    const scrollbackLength = this.getScrollbackLength();
    const maxScroll = scrollbackLength;

    // Calculate new viewport position
    // viewportY = 0 means at bottom (no scroll)
    // viewportY > 0 means scrolled up into history
    // amount < 0 (scroll up) should INCREASE viewportY
    // amount > 0 (scroll down) should DECREASE viewportY
    // So we SUBTRACT amount (negative amount becomes positive change)
    const newViewportY = Math.max(0, Math.min(maxScroll, this.viewportY - amount));

    if (newViewportY !== this.viewportY) {
      this.viewportY = newViewportY;
      this.fireScroll();

      // Show scrollbar when scrolling (with auto-hide)
      if (scrollbackLength > 0) {
        this.showScrollbar();
      }
    }
  }

  /**
   * Scroll viewport by a number of pages
   * @param amount Number of pages to scroll (positive = down, negative = up)
   */
  public scrollPages(amount: number): void {
    this.scrollLines(amount * this.rows);
  }

  /**
   * Scroll viewport to the top of the scrollback buffer
   */
  public scrollToTop(): void {
    this.wake();
    const scrollbackLength = this.getScrollbackLength();
    if (scrollbackLength > 0 && this.viewportY !== scrollbackLength) {
      this.viewportY = scrollbackLength;
      this.fireScroll();
      this.showScrollbar();
    }
  }

  /**
   * Scroll viewport to the bottom (current output)
   */
  public scrollToBottom(): void {
    this.wake();
    if (this.viewportY !== 0) {
      this.viewportY = 0;
      this.fireScroll();
      // Show scrollbar briefly when scrolling to bottom
      if (this.getScrollbackLength() > 0) {
        this.showScrollbar();
      }
    }
  }

  /** Scrolls so that absolute buffer line `line` (0 = oldest scrollback line) is at the top, like xterm.js. */
  public scrollToLine(line: number): void {
    const scrollbackLength = this.getScrollbackLength();
    const top = Math.max(0, Math.min(scrollbackLength, Math.round(line)));
    this.scrollToViewportY(scrollbackLength - top);
  }

  /** Scrolls to `viewportY` lines above the bottom. */
  private scrollToViewportY(viewportY: number): void {
    this.wake();
    const scrollbackLength = this.getScrollbackLength();
    const newViewportY = Math.max(0, Math.min(scrollbackLength, Math.round(viewportY)));

    if (newViewportY !== this.viewportY) {
      this.viewportY = newViewportY;
      this.fireScroll();

      // Show scrollbar when scrolling to specific line
      if (scrollbackLength > 0) {
        this.showScrollbar();
      }
    }
  }

  /**
   * Smoothly scroll to a target viewport position
   * @param targetY Target viewport Y position (in lines, can be fractional)
   */
  private smoothScrollTo(targetY: number): void {
    if (!this.wasmTerm) return;

    const scrollbackLength = this.getScrollbackLength();
    const maxScroll = scrollbackLength;

    // Clamp target to valid range
    const newTarget = Math.max(0, Math.min(maxScroll, targetY));

    // If smooth scrolling is disabled (duration = 0), jump immediately
    const duration = this.options.smoothScrollDuration ?? 100;
    if (duration === 0) {
      this.viewportY = newTarget;
      this.targetViewportY = newTarget;
      this.fireScroll();

      if (scrollbackLength > 0) {
        this.showScrollbar();
      }
      return;
    }

    // Update target (accumulate if animation running)
    this.targetViewportY = newTarget;

    // If animation is already running, don't restart it
    // Just let it continue toward the updated target
    // This prevents choppy restarts during continuous scrolling
    if (this.scrollAnimationFrame) {
      return;
    }

    // Start new animation
    this.scrollAnimationStartTime = Date.now();
    this.animateScroll();
  }

  /**
   * Animation loop for smooth scrolling
   * Uses asymptotic approach - moves a fraction of remaining distance each frame
   */
  private animateScroll = (): void => {
    this.wake();
    if (!this.wasmTerm || this.scrollAnimationStartTime === undefined) {
      return;
    }

    const duration = this.options.smoothScrollDuration ?? 100;

    // Calculate distance to target
    const distance = this.targetViewportY - this.viewportY;
    const absDistance = Math.abs(distance);

    // If very close, snap to target
    if (absDistance < 0.01) {
      this.viewportY = this.targetViewportY;
      this.fireScroll();

      const scrollbackLength = this.getScrollbackLength();
      if (scrollbackLength > 0) {
        this.showScrollbar();
      }

      // Animation complete
      this.scrollAnimationFrame = undefined;
      this.scrollAnimationStartTime = undefined;
      return;
    }

    // Move a fraction of the remaining distance
    // At 60fps, move ~1/6 of distance per frame for ~100ms total duration
    // This creates smooth deceleration toward target
    const framesForDuration = (duration / 1000) * 60; // Convert ms to frame count
    const moveRatio = 1 - (1 / framesForDuration) ** 2; // Ease-out
    this.viewportY += distance * moveRatio;

    // Fire scroll event
    this.fireScroll();

    // Show scrollbar during animation
    const scrollbackLength = this.getScrollbackLength();
    if (scrollbackLength > 0) {
      this.showScrollbar();
    }

    // Continue animation
    this.scrollAnimationFrame = requestAnimationFrame(this.animateScroll);
  };

  // ==========================================================================
  // Lifecycle
  // ==========================================================================

  /**
   * Dispose terminal and clean up resources
   */
  dispose(): void {
    if (this.isDisposed) {
      return;
    }

    this.isDisposed = true;
    this.isOpen = false;

    // Stop render loop and clear write queue
    this.cancelRenderLoop();
    this.writeQueue.length = 0;

    // Stop smooth scroll animation
    if (this.scrollAnimationFrame) {
      cancelAnimationFrame(this.scrollAnimationFrame);
      this.scrollAnimationFrame = undefined;
    }

    // Clear mouse move throttle timeout
    if (this.mouseMoveThrottleTimeout) {
      clearTimeout(this.mouseMoveThrottleTimeout);
      this.mouseMoveThrottleTimeout = undefined;
    }
    this.pendingMouseMove = undefined;

    // Dispose addons
    for (const addon of this.addons) {
      addon.dispose();
    }
    this.addons = [];

    // Clean up components
    this.cleanupComponents();

    // Dispose event emitters
    this.dataEmitter.dispose();
    this.resizeEmitter.dispose();
    this.bellEmitter.dispose();
    this.selectionChangeEmitter.dispose();
    this.keyEmitter.dispose();
    this.titleChangeEmitter.dispose();
    this.scrollEmitter.dispose();
    this.renderEmitter.dispose();
    this.cursorMoveEmitter.dispose();
    this.writeParsedEmitter.dispose();
  }

  // ==========================================================================
  // Private Methods
  // ==========================================================================

  /**
   * Cancel the render loop
   */
  private cancelRenderLoop(): void {
    if (this.animationFrameId) {
      cancelAnimationFrame(this.animationFrameId);
      this.animationFrameId = undefined;
    }
  }

  /**
   * Flush any writes that were queued during resize
   */
  private flushWriteQueue(): void {
    while (this.writeQueue.length > 0) {
      const data = this.writeQueue.shift()!;
      this.wasmTerm!.write(data);
    }
  }

  /**
   * Start the render loop
   */
  private startRenderLoop(): void {
    if (this.animationFrameId) return;
    const loop = () => {
      this.animationFrameId = undefined;
      if (this.isDisposed || !this.isOpen) return;
      const drew = this.wasmTerm!.update() !== DirtyState.NONE;
      this.renderer!.render(this.wasmTerm!, false, this.viewportY, this, this.scrollbarOpacity);
      if (drew) this.renderEmitter.fire({ start: 0, end: this.rows - 1 });
      const cursor = this.wasmTerm!.getCursor();
      if (cursor.y !== this.lastCursorY) {
        this.lastCursorY = cursor.y;
        this.cursorMoveEmitter.fire();
      }
      if (this.idleFrames++ < Terminal.IDLE_FRAMES_BEFORE_SLEEP) {
        this.animationFrameId = requestAnimationFrame(loop);
      }
    };
    this.animationFrameId = requestAnimationFrame(loop);
  }

  /**
   * Get a line from native WASM scrollback buffer
   * Implements IScrollbackProvider
   */
  public getScrollbackLine(offset: number): GhosttyCell[] | null {
    if (!this.wasmTerm) return null;
    return this.wasmTerm.getScrollbackLine(offset);
  }

  /**
   * Get scrollback length from native WASM
   * Implements IScrollbackProvider
   */
  public getScrollbackLength(): number {
    if (!this.wasmTerm) return 0;
    return this.wasmTerm.getScrollbackLength();
  }

  /**
   * Clean up components (called on dispose or error)
   */
  private cleanupComponents(): void {
    // Dispose selection manager
    if (this.selectionManager) {
      this.selectionManager.dispose();
      this.selectionManager = undefined;
    }

    // Dispose input handler
    if (this.inputHandler) {
      this.inputHandler.dispose();
      this.inputHandler = undefined;
    }

    // Dispose renderer
    if (this.renderer) {
      this.renderer.dispose();
      this.renderer = undefined;
    }

    // Remove canvas from DOM
    if (this.canvas && this.canvas.parentNode) {
      this.canvas.parentNode.removeChild(this.canvas);
      this.canvas = undefined;
    }

    // Remove textarea from DOM
    if (this.textarea && this.textarea.parentNode) {
      this.textarea.parentNode.removeChild(this.textarea);
      this.textarea = undefined;
    }

    // Remove event listeners
    if (this.element) {
      this.element.removeEventListener('wheel', this.handleWheel);
      this.element.removeEventListener('mousedown', this.handleMouseDown, { capture: true });
      this.element.removeEventListener('mousemove', this.handleMouseMove);
      this.element.removeEventListener('mouseleave', this.handleMouseLeave);
      this.element.removeEventListener('focusin', this.handleFocusIn);
      this.element.removeEventListener('focusout', this.handleFocusOut);
      this.element.removeEventListener('click', this.handleClick);

      // Remove contenteditable and accessibility attributes added in open()
      this.element.removeAttribute('contenteditable');
      this.element.removeAttribute('role');
      this.element.removeAttribute('aria-label');
      this.element.removeAttribute('aria-multiline');
    }

    // Remove document-level listeners (only if opened)
    if (this.isOpen && typeof document !== 'undefined') {
      document.removeEventListener('mouseup', this.handleMouseUp);
    }

    // Clean up scrollbar timers
    if (this.scrollbarHideTimeout) {
      window.clearTimeout(this.scrollbarHideTimeout);
      this.scrollbarHideTimeout = undefined;
    }

    // Dispose link detector
    if (this.linkDetector) {
      this.linkDetector.dispose();
      this.linkDetector = undefined;
    }

    // Free WASM terminal
    if (this.wasmTerm) {
      this.wasmTerm.free();
      this.wasmTerm = undefined;
    }

    // Clear references
    this.ghostty = undefined;
    this.element = undefined;
    this.textarea = undefined;
  }

  /**
   * Assert terminal is open (throw if not)
   */
  private assertOpen(): void {
    if (this.isDisposed) {
      throw new Error('Terminal has been disposed');
    }
    if (!this.isOpen) {
      throw new Error('Terminal must be opened before use. Call terminal.open(parent) first.');
    }
  }

  /**
   * Handle mouse move for link hover detection and scrollbar dragging
   * Throttled to avoid blocking scroll events (except when dragging scrollbar)
   */
  private handleMouseMove = (e: MouseEvent): void => {
    this.wake();
    if (!this.canvas || !this.renderer || !this.wasmTerm) return;

    // If dragging scrollbar, handle immediately without throttling
    if (this.isDraggingScrollbar) {
      this.processScrollbarDrag(e);
      return;
    }

    if (!this.linkDetector) return;

    // Throttle to ~60fps (16ms) to avoid blocking scroll/other events
    if (this.mouseMoveThrottleTimeout) {
      this.pendingMouseMove = e;
      return;
    }

    this.processMouseMove(e);

    this.mouseMoveThrottleTimeout = window.setTimeout(() => {
      this.mouseMoveThrottleTimeout = undefined;
      if (this.pendingMouseMove) {
        const pending = this.pendingMouseMove;
        this.pendingMouseMove = undefined;
        this.processMouseMove(pending);
      }
    }, 16);
  };

  /**
   * Process mouse move for link detection (internal, called by throttled handler)
   */
  private processMouseMove(e: MouseEvent): void {
    if (!this.canvas || !this.renderer || !this.linkDetector || !this.wasmTerm) return;

    // Convert mouse coordinates to terminal cell position
    const rect = this.canvas.getBoundingClientRect();
    const x = Math.floor((e.clientX - rect.left) / this.renderer.charWidth);
    const y = Math.floor((e.clientY - rect.top) / this.renderer.charHeight);

    // Get hyperlink_id directly from the cell at this position
    // Must account for viewportY (scrollback position)
    const viewportRow = y; // Row in the viewport (0 to rows-1)
    let hyperlinkId = 0;

    // When scrolled, fetch from scrollback or screen based on position
    // NOTE: viewportY may be fractional during smooth scrolling. The renderer
    // uses Math.floor(viewportY) when mapping viewport rows to scrollback vs
    // screen; we mirror that logic here so link hit-testing matches what the
    // user sees on screen.
    let line: GhosttyCell[] | null = null;
    const rawViewportY = this.getViewportY();
    const viewportY = Math.max(0, Math.floor(rawViewportY));
    if (viewportY > 0) {
      const scrollbackLength = this.wasmTerm.getScrollbackLength();
      if (viewportRow < viewportY) {
        // Mouse is over scrollback content
        const scrollbackOffset = scrollbackLength - viewportY + viewportRow;
        line = this.wasmTerm.getScrollbackLine(scrollbackOffset);
      } else {
        // Mouse is over screen content (bottom part of viewport)
        const screenRow = viewportRow - viewportY;
        line = this.wasmTerm.getLine(screenRow);
      }
    } else {
      // At bottom - just use screen buffer
      line = this.wasmTerm.getLine(viewportRow);
    }

    if (line && x >= 0 && x < line.length) {
      hyperlinkId = line[x].hyperlink_id;
    }

    // Update renderer for underline rendering
    const previousHyperlinkId = (this.renderer as any).hoveredHyperlinkId || 0;
    if (hyperlinkId !== previousHyperlinkId) {
      this.renderer.setHoveredHyperlinkId(hyperlinkId);

      // The 60fps render loop will pick up the change automatically
      // No need to force a render - this keeps performance smooth
    }

    // Check if there's a link at this position (for click handling and cursor)
    // Buffer API expects absolute buffer coordinates (including scrollback)
    // When scrolled, we need to adjust the buffer row based on viewportY
    const scrollbackLength = this.wasmTerm.getScrollbackLength();
    let bufferRow: number;

    // Use floored viewportY for buffer mapping (must match renderer & selection)
    const rawViewportYForBuffer = this.getViewportY();
    const viewportYForBuffer = Math.max(0, Math.floor(rawViewportYForBuffer));

    if (viewportYForBuffer > 0) {
      // When scrolled, the buffer row depends on where in the viewport we are
      if (viewportRow < viewportYForBuffer) {
        // Mouse is over scrollback content
        bufferRow = scrollbackLength - viewportYForBuffer + viewportRow;
      } else {
        // Mouse is over screen content (bottom part of viewport)
        const screenRow = viewportRow - viewportYForBuffer;
        bufferRow = scrollbackLength + screenRow;
      }
    } else {
      // At bottom - buffer row is scrollback + screen row
      bufferRow = scrollbackLength + viewportRow;
    }

    // Make async call non-blocking - don't await
    this.linkDetector
      .getLinkAt(x, bufferRow)
      .then((link) => {
        // Update hover state for cursor changes and click handling
        if (link !== this.currentHoveredLink) {
          // Notify old link we're leaving
          this.currentHoveredLink?.hover?.(false);

          // Update current link
          this.currentHoveredLink = link;

          // Notify new link we're entering
          link?.hover?.(true);

          // Update cursor style on both container and canvas
          const cursorStyle = link ? 'pointer' : 'text';
          if (this.element) {
            this.element.style.cursor = cursorStyle;
          }
          if (this.canvas) {
            this.canvas.style.cursor = cursorStyle;
          }

          // Update renderer for underline (for regex URLs without hyperlink_id)
          if (this.renderer) {
            if (link) {
              // Convert buffer coordinates to viewport coordinates
              const scrollbackLength = this.wasmTerm?.getScrollbackLength() || 0;

              // Calculate viewport Y for start and end positions
              // Use floored viewportY so overlay rows match renderer & selection
              const rawViewportYForLinks = this.getViewportY();
              const viewportYForLinks = Math.max(0, Math.floor(rawViewportYForLinks));
              const startViewportY = link.range.start.y - scrollbackLength + viewportYForLinks;
              const endViewportY = link.range.end.y - scrollbackLength + viewportYForLinks;

              // Only show underline if link is visible in viewport
              if (startViewportY < this.rows && endViewportY >= 0) {
                this.renderer.setHoveredLinkRange({
                  startX: link.range.start.x,
                  startY: Math.max(0, startViewportY),
                  endX: link.range.end.x,
                  endY: Math.min(this.rows - 1, endViewportY),
                });
              } else {
                this.renderer.setHoveredLinkRange(null);
              }
            } else {
              this.renderer.setHoveredLinkRange(null);
            }
          }
        }
      })
      .catch((err) => {
        console.warn('Link detection error:', err);
      });
  }

  /**
   * Handle mouse leave to clear link hover
   */
  private handleMouseLeave = (): void => {
    this.wake();
    // Clear hyperlink underline
    if (this.renderer && this.wasmTerm) {
      const previousHyperlinkId = (this.renderer as any).hoveredHyperlinkId || 0;
      if (previousHyperlinkId > 0) {
        this.renderer.setHoveredHyperlinkId(0);

        // The 60fps render loop will pick up the change automatically
      }
      // Clear regex link underline
      this.renderer.setHoveredLinkRange(null);
    }

    if (this.currentHoveredLink) {
      // Notify link we're leaving
      this.currentHoveredLink.hover?.(false);

      // Clear hovered link
      this.currentHoveredLink = undefined;

      // Reset cursor
      if (this.element) {
        this.element.style.cursor = 'text';
        if (this.canvas) {
          this.canvas.style.cursor = 'text';
        }
      }
    }
  };

  /**
   * Handle mouse click for link activation
   */
  private handleClick = async (e: MouseEvent): Promise<void> => {
    this.wake();
    // For more reliable clicking, detect the link at click time
    // rather than relying on cached hover state (avoids async races)
    if (!this.canvas || !this.renderer || !this.linkDetector || !this.wasmTerm) return;

    // Get click position
    const rect = this.canvas.getBoundingClientRect();
    const x = Math.floor((e.clientX - rect.left) / this.renderer.charWidth);
    const y = Math.floor((e.clientY - rect.top) / this.renderer.charHeight);

    // Calculate buffer row (same logic as processMouseMove)
    const viewportRow = y;
    const scrollbackLength = this.wasmTerm.getScrollbackLength();
    let bufferRow: number;

    // Use floored viewportY for buffer mapping (must match renderer & selection)
    const rawViewportYForClick = this.getViewportY();
    const viewportYForClick = Math.max(0, Math.floor(rawViewportYForClick));

    if (viewportYForClick > 0) {
      if (viewportRow < viewportYForClick) {
        bufferRow = scrollbackLength - viewportYForClick + viewportRow;
      } else {
        const screenRow = viewportRow - viewportYForClick;
        bufferRow = scrollbackLength + screenRow;
      }
    } else {
      bufferRow = scrollbackLength + viewportRow;
    }

    // Get the link at this position
    const link = await this.linkDetector.getLinkAt(x, bufferRow);

    if (link) {
      // Activate link
      link.activate(e);

      // Prevent default action if modifier key held
      if (e.ctrlKey || e.metaKey) {
        e.preventDefault();
      }
    }
  };

  /**
   * Handle wheel events for scrolling (Phase 2)
   */
  private handleWheel = (e: WheelEvent): void => {
    this.wake();
    // Always prevent default browser scrolling
    e.preventDefault();
    e.stopPropagation();

    // Allow custom handler to override
    if (this.customWheelEventHandler && this.customWheelEventHandler(e)) {
      return;
    }

    // Check if in alternate screen mode (vim, less, htop, etc.)
    const isAltScreen = this.wasmTerm?.isAlternateScreen() ?? false;

    if (isAltScreen) {
      // Alternate screen: send arrow keys to the application
      // Applications like vim handle scrolling internally
      // Standard: ~3 arrow presses per wheel "click"
      const direction = e.deltaY > 0 ? 'down' : 'up';
      const count = Math.min(Math.abs(Math.round(e.deltaY / 33)), 5); // Cap at 5

      for (let i = 0; i < count; i++) {
        if (direction === 'up') {
          this.dataEmitter.fire('\x1B[A'); // Up arrow
        } else {
          this.dataEmitter.fire('\x1B[B'); // Down arrow
        }
      }
    } else {
      // Normal screen: scroll viewport through history with smooth scrolling
      // Handle different deltaMode values for better trackpad/mouse support
      let deltaLines: number;

      if (e.deltaMode === WheelEvent.DOM_DELTA_PIXEL) {
        // Pixel mode (trackpads): convert pixels to lines
        // Use actual line height from renderer for accurate conversion
        const lineHeight = this.renderer?.getMetrics()?.height ?? 20;
        deltaLines = e.deltaY / lineHeight;
      } else if (e.deltaMode === WheelEvent.DOM_DELTA_LINE) {
        // Line mode (some mice): use directly
        deltaLines = e.deltaY;
      } else if (e.deltaMode === WheelEvent.DOM_DELTA_PAGE) {
        // Page mode (rare): convert pages to lines
        deltaLines = e.deltaY * this.rows;
      } else {
        // Fallback: assume pixel mode with legacy divisor
        deltaLines = e.deltaY / 33;
      }

      deltaLines *= this.options.scrollSensitivity;

      // Use smooth scrolling for any amount (no rounding needed)
      if (deltaLines !== 0) {
        // Calculate target position
        // deltaY > 0 = scroll down (decrease viewportY)
        // deltaY < 0 = scroll up (increase viewportY)
        const targetY = this.viewportY - deltaLines;
        this.smoothScrollTo(targetY);
      }
    }
  };

  /**
   * Handle mouse down for scrollbar interaction
   */
  private handleMouseDown = (e: MouseEvent): void => {
    this.wake();
    if (!this.canvas || !this.renderer || !this.wasmTerm) return;

    const scrollbackLength = this.wasmTerm.getScrollbackLength();
    if (scrollbackLength === 0) return; // No scrollbar if no scrollback

    const rect = this.canvas.getBoundingClientRect();
    const mouseX = e.clientX - rect.left;
    const mouseY = e.clientY - rect.top;

    // Calculate scrollbar dimensions (match renderer's logic)
    // Use rect dimensions which are already in CSS pixels
    const canvasWidth = rect.width;
    const canvasHeight = rect.height;
    const scrollbarWidth = 8;
    const scrollbarX = canvasWidth - scrollbarWidth - 4;
    const scrollbarPadding = 4;

    // Check if click is in scrollbar area
    if (mouseX >= scrollbarX && mouseX <= scrollbarX + scrollbarWidth) {
      // Prevent default and stop propagation to prevent text selection
      e.preventDefault();
      e.stopPropagation();
      e.stopImmediatePropagation(); // Stop SelectionManager from seeing this event

      // Calculate scrollbar thumb position and size
      const scrollbarTrackHeight = canvasHeight - scrollbarPadding * 2;
      const visibleRows = this.rows;
      const totalLines = scrollbackLength + visibleRows;
      const thumbHeight = Math.max(20, (visibleRows / totalLines) * scrollbarTrackHeight);
      const scrollPosition = this.viewportY / scrollbackLength;
      const thumbY = scrollbarPadding + (scrollbarTrackHeight - thumbHeight) * (1 - scrollPosition);

      // Check if click is on thumb
      if (mouseY >= thumbY && mouseY <= thumbY + thumbHeight) {
        // Start dragging thumb
        this.isDraggingScrollbar = true;
        this.scrollbarDragStart = mouseY;
        this.scrollbarDragStartViewportY = this.viewportY;

        // Prevent text selection during drag
        if (this.canvas) {
          this.canvas.style.userSelect = 'none';
          this.canvas.style.webkitUserSelect = 'none';
        }
      } else {
        // Click on track - jump to position
        const relativeY = mouseY - scrollbarPadding;
        const scrollFraction = 1 - relativeY / scrollbarTrackHeight; // Inverted: top = 1, bottom = 0
        const targetViewportY = Math.round(scrollFraction * scrollbackLength);
        this.scrollToViewportY(targetViewportY);
      }
    }
  };

  /**
   * Handle mouse up for scrollbar drag
   */
  private handleMouseUp = (): void => {
    this.wake();
    if (this.isDraggingScrollbar) {
      this.isDraggingScrollbar = false;
      this.scrollbarDragStart = null;

      // Restore text selection
      if (this.canvas) {
        this.canvas.style.userSelect = '';
        this.canvas.style.webkitUserSelect = '';
      }

      // Schedule auto-hide after drag ends
      if (this.scrollbarVisible && this.getScrollbackLength() > 0) {
        this.showScrollbar(); // Reset the hide timer
      }
    }
  };

  /**
   * Process scrollbar drag movement
   */
  private processScrollbarDrag(e: MouseEvent): void {
    if (!this.canvas || !this.renderer || !this.wasmTerm || this.scrollbarDragStart === null)
      return;

    const scrollbackLength = this.wasmTerm.getScrollbackLength();
    if (scrollbackLength === 0) return;

    const rect = this.canvas.getBoundingClientRect();
    const mouseY = e.clientY - rect.top;

    // Calculate how much the mouse moved
    const deltaY = mouseY - this.scrollbarDragStart;

    // Convert mouse delta to viewport delta
    // Use rect height which is already in CSS pixels
    const canvasHeight = rect.height;
    const scrollbarPadding = 4;
    const scrollbarTrackHeight = canvasHeight - scrollbarPadding * 2;
    const visibleRows = this.rows;
    const totalLines = scrollbackLength + visibleRows;
    const thumbHeight = Math.max(20, (visibleRows / totalLines) * scrollbarTrackHeight);

    // Calculate scroll fraction from thumb movement
    // Note: thumb moves in opposite direction to viewport (thumb down = scroll down = viewportY decreases)
    const scrollFraction = -deltaY / (scrollbarTrackHeight - thumbHeight);
    const viewportDelta = Math.round(scrollFraction * scrollbackLength);

    const newViewportY = this.scrollbarDragStartViewportY + viewportDelta;
    this.scrollToViewportY(newViewportY);
  }

  /**
   * Show scrollbar with fade-in and schedule auto-hide
   */
  private showScrollbar(): void {
    this.wake();
    // Clear any existing hide timeout
    if (this.scrollbarHideTimeout) {
      window.clearTimeout(this.scrollbarHideTimeout);
      this.scrollbarHideTimeout = undefined;
    }

    // If not visible, start fade-in
    if (!this.scrollbarVisible) {
      this.scrollbarVisible = true;
      this.scrollbarOpacity = 0;
      this.fadeInScrollbar();
    } else {
      // Already visible, just ensure it's fully opaque
      this.scrollbarOpacity = 1;
    }

    // Schedule auto-hide (unless dragging)
    if (!this.isDraggingScrollbar) {
      this.scrollbarHideTimeout = window.setTimeout(() => {
        this.hideScrollbar();
      }, this.SCROLLBAR_HIDE_DELAY_MS);
    }
  }

  /**
   * Hide scrollbar with fade-out
   */
  private hideScrollbar(): void {
    this.wake();
    if (this.scrollbarHideTimeout) {
      window.clearTimeout(this.scrollbarHideTimeout);
      this.scrollbarHideTimeout = undefined;
    }

    if (this.scrollbarVisible) {
      this.fadeOutScrollbar();
    }
  }

  /**
   * Fade in scrollbar
   */
  private fadeInScrollbar(): void {
    this.wake();
    const startTime = Date.now();
    const animate = () => {
      const elapsed = Date.now() - startTime;
      const progress = Math.min(elapsed / this.SCROLLBAR_FADE_DURATION_MS, 1);
      this.scrollbarOpacity = progress;

      // Trigger render to show updated opacity
      if (this.renderer && this.wasmTerm) {
        this.renderer.render(this.wasmTerm, false, this.viewportY, this, this.scrollbarOpacity);
      }

      if (progress < 1) {
        requestAnimationFrame(animate);
      }
    };
    animate();
  }

  /**
   * Fade out scrollbar
   */
  private fadeOutScrollbar(): void {
    this.wake();
    const startTime = Date.now();
    const startOpacity = this.scrollbarOpacity;
    const animate = () => {
      const elapsed = Date.now() - startTime;
      const progress = Math.min(elapsed / this.SCROLLBAR_FADE_DURATION_MS, 1);
      this.scrollbarOpacity = startOpacity * (1 - progress);

      // Trigger render to show updated opacity
      if (this.renderer && this.wasmTerm) {
        this.renderer.render(this.wasmTerm, false, this.viewportY, this, this.scrollbarOpacity);
      }

      if (progress < 1) {
        requestAnimationFrame(animate);
      } else {
        this.scrollbarVisible = false;
        this.scrollbarOpacity = 0;
        // Final render to clear scrollbar completely
        if (this.renderer && this.wasmTerm) {
          this.renderer.render(this.wasmTerm, false, this.viewportY, this, 0);
        }
      }
    };
    animate();
  }

  /**
   * Process any pending terminal responses and emit them via onData.
   *
   * This handles escape sequences that require the terminal to send a response
   * back to the PTY, such as:
   * - DSR 6 (cursor position): Shell sends \x1b[6n, terminal responds with \x1b[row;colR
   * - DSR 5 (operating status): Shell sends \x1b[5n, terminal responds with \x1b[0n
   *
   * Without this, shells like nushell that rely on cursor position queries
   * will hang waiting for a response that never comes.
   *
   * Note: We loop to read all pending responses, not just one. This is important
   * when multiple queries are processed in a single write() call (e.g., when
   * buffered data is written all at once during terminal initialization).
   */
  private processTerminalResponses(): void {
    if (!this.wasmTerm) return;

    // Read all pending responses from the WASM terminal
    // Multiple responses can be queued if a single write() contained multiple queries
    while (true) {
      const response = this.wasmTerm.readResponse();
      if (response === null) break;
      if (!this.answerQueries) continue;
      // Send response back to the PTY via onData
      // This is the same path as user keyboard input
      this.dataEmitter.fire(response);
    }
  }

  // ============================================================================
  // Host hooks: markers, clipboard, modes
  // ============================================================================

  /**
   * Adds a marker on the cursor's line plus `cursorYOffset`, like xterm.js.
   * Returns undefined when that line is outside the active area.
   */
  public registerMarker(cursorYOffset: number = 0): IMarker | undefined {
    if (!this.wasmTerm) return undefined;
    const y = this.wasmTerm.cursorPosition().y + cursorYOffset;
    if (y < 0 || y >= this.rows) return undefined;
    // Starts watching the active screen for discarded rows before the marker exists.
    if (this.wasmTerm.rowsDiscarded()) this.refreshMarkers(true);
    const row = this.wasmTerm.trackRow(y);
    if (!row) return undefined;
    const marker = new Marker(row);
    this.markers.add(marker);
    marker.onDispose(() => this.markers.delete(marker));
    return marker;
  }

  /**
   * Decides OSC 52 clipboard writes synchronously (true allows the write).
   * Unset, every write is denied; clipboard reads are never answered.
   */
  public set clipboardWriteHandler(handler: ((text: string) => boolean) | null) {
    this.clipboardHandler = handler;
    if (this.wasmTerm) this.wasmTerm.clipboardWriteHandler = handler;
  }

  public get clipboardWriteHandler(): ((text: string) => boolean) | null {
    return this.clipboardHandler;
  }

  /** xterm.js-compatible terminal modes. */
  public get modes(): {
    mouseTrackingMode: MouseTrackingMode;
    bracketedPasteMode: boolean;
    applicationCursorKeysMode: boolean;
    sendFocusMode: boolean;
  } {
    return {
      mouseTrackingMode: this.wasmTerm?.mouseTrackingMode() ?? 'none',
      bracketedPasteMode: this.wasmTerm?.hasBracketedPaste() ?? false,
      applicationCursorKeysMode: this.wasmTerm?.getMode(1, false) ?? false,
      sendFocusMode: this.wasmTerm?.hasFocusEvents() ?? false,
    };
  }

  private focused = false;

  private readonly handleFocusIn = (): void => this.setFocused(true);

  private readonly handleFocusOut = (event: FocusEvent): void => {
    const next = event.relatedTarget;
    if (next instanceof Node && this.element?.contains(next)) return;
    this.setFocused(false);
  };

  private setFocused(focused: boolean): void {
    if (focused === this.focused) return;
    this.focused = focused;
    this.renderer?.setFocused(focused);
    this.requestFrame();
  }

  /** Draws one frame, for a change that needs no follow-up frames (a cursor blink). */
  private requestFrame(): void {
    if (this.animationFrameId) return;
    this.idleFrames = Terminal.IDLE_FRAMES_BEFORE_SLEEP;
    if (this.isOpen && !this.isDisposed) this.startRenderLoop();
  }

  /** Keeps the render loop running for a while; called whenever something may need drawing. */
  public wake(): void {
    this.idleFrames = 0;
    if (this.isOpen && !this.isDisposed) this.startRenderLoop();
  }

  private wireEngine(): void {
    for (const sub of this.engineSubscriptions) sub.dispose();
    const engine = this.wasmTerm!;
    engine.clipboardWriteHandler = this.clipboardHandler;
    this.lastAlternate = engine.isAlternateScreen();
    this.engineSubscriptions = [
      engine.onBell(() => this.bellEmitter.fire()),
      engine.onTitleChange((title) => {
        if (title === this.currentTitle) return;
        this.currentTitle = title;
        this.titleChangeEmitter.fire(title);
      }),
      engine.onPwdChange((pwd) => this.pwdEmitter.fire(pwd)),
      engine.onSemanticPrompt((event) => this.semanticPromptEmitter.fire(event)),
      engine.onDesktopNotification((n) => this.desktopNotificationEmitter.fire(n)),
      engine.onUnknownOsc((content) => this.unknownOscEmitter.fire(content)),
    ];
  }

  private afterWrite(): void {
    const engine = this.wasmTerm;
    if (!engine) return;
    const alternate = engine.isAlternateScreen();
    if (alternate !== this.lastAlternate) {
      this.lastAlternate = alternate;
      (this.buffer as BufferNamespace)._fireBufferChange(this.buffer.active);
      this.refreshMarkers(true);
    } else {
      this.refreshMarkers(false);
    }
    this.writeParsedEmitter.fire();
    this.wake();
  }

  private searchHighlights: {
    list: SearchHighlight[] | null;
    colors?: SearchHighlightColors;
  } = { list: null };

  /** Shows search matches on viewport rows (null clears them). Used by SearchAddon. */
  setSearchHighlights(list: SearchHighlight[] | null, colors?: SearchHighlightColors): void {
    this.searchHighlights = { list, colors: colors ?? this.searchHighlights.colors };
    this.renderer?.setSearchHighlights(list, colors);
    this.wake();
  }

  /** Fires onScroll with the absolute line at the top of the viewport, as xterm.js does. */
  private fireScroll(): void {
    this.scrollEmitter.fire(this.buffer.active.viewportY);
  }

  /** Disposes the markers whose line is gone; only rows the engine discarded can be. */
  private refreshMarkers(force: boolean): void {
    if (this.markers.size === 0 || !this.wasmTerm) return;
    if (!this.wasmTerm.rowsDiscarded() && !force) return;
    for (const marker of [...this.markers]) marker.refresh();
  }

  private disposeMarkers(): void {
    for (const marker of [...this.markers]) marker.dispose();
    this.markers.clear();
  }

  // ============================================================================
  // Terminal Modes
  // ============================================================================

  /**
   * Query terminal mode state
   *
   * @param mode Mode number (e.g., 2004 for bracketed paste)
   * @param isAnsi True for ANSI modes, false for DEC modes (default: false)
   * @returns true if mode is enabled
   */
  public getMode(mode: number, isAnsi: boolean = false): boolean {
    this.assertOpen();
    return this.wasmTerm!.getMode(mode, isAnsi);
  }

  /**
   * Check if bracketed paste mode is enabled
   */
  public hasBracketedPaste(): boolean {
    this.assertOpen();
    return this.wasmTerm!.hasBracketedPaste();
  }

  /**
   * Check if focus event reporting is enabled
   */
  public hasFocusEvents(): boolean {
    this.assertOpen();
    return this.wasmTerm!.hasFocusEvents();
  }

  /**
   * Check if mouse tracking is enabled
   */
  public hasMouseTracking(): boolean {
    this.assertOpen();
    return this.wasmTerm!.hasMouseTracking();
  }
}
