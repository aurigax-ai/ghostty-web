# ghostty-web (AurigaX)

[Ghostty](https://github.com/ghostty-org/ghostty)'s terminal engine in the browser, with an
[xterm.js](https://github.com/xtermjs/xterm.js)-shaped API and WebGL and canvas renderers. It is the engine
behind the Ghostty terminal in Ostia.

This is a hard fork of [coder/ghostty-web](https://github.com/coder/ghostty-web) (MIT, © Coder),
kept with its history. It does not track upstream. What changed:

- **Official, unpatched libghostty-vt.** ghostty-web built Ghostty with a patch that added its own
  C functions. This fork builds Ghostty's published libghostty-vt API at a pinned commit
  (`GHOSTTY_COMMIT`) and talks to it through `lib/abi.ts`, which reads struct layouts from
  `ghostty_type_json()` so a field that moves fails loudly instead of reading garbage.
- **Host hooks.** JavaScript callbacks reach libghostty-vt through its growable function table
  (`Abi.addCallback`), so the host can receive prompt marks (OSC 133), the working directory with
  its host (OSC 7), notifications, clipboard writes and unknown sequences, and keep markers as
  tracked grid references.
- **WebGL renderer.** `renderer: 'webgl'` (the default) draws with WebGL 2 from a glyph atlas,
  rewriting only the rows that changed and drawing only the cells and glyph pixels that show
  something; without WebGL 2, or when its context is lost, the terminal
  draws with the canvas renderer instead (`renderer: 'canvas'` asks for it). Both draw box drawing
  and block elements from geometry, so they fill their cells.
- **pnpm and Vitest** instead of Bun; no demo server, benchmark or release automation.

## Install

```sh
pnpm add @aurigax-ai/ghostty-web
```

The package ships its TypeScript source and `ghostty-vt.wasm`; bundle it with Vite or similar.

## Build

Needs [Zig](https://ziglang.org) 0.16.0 and pnpm. Use the official Zig tarball (as CI does): a
distribution's Zig built against its own LLVM produces a different, equally valid `ghostty-vt.wasm`,
and CI checks that the committed file matches the official build. Point `ZIG` at it if it is not the
`zig` on your PATH: `ZIG=/path/to/zig pnpm build:wasm`.

```sh
pnpm install
pnpm build:wasm   # clones Ghostty at GHOSTTY_COMMIT into vendor/ and builds ghostty-vt.wasm
pnpm test
pnpm build        # dist/ with the library and the WASM
```

libghostty-vt's API is not stable yet, so `GHOSTTY_COMMIT` is raised on purpose, with the tests as
the guard. The built `ghostty-vt.wasm` is committed so the package installs without Zig; the build
is reproducible and CI fails if the committed file differs from a fresh build of the pinned commit.
The package exports its TypeScript source (`lib/index.ts`), for bundlers such as Vite.

## Host hooks

Besides the xterm.js-shaped API, `Terminal` exposes what libghostty-vt reports, at its exact place
in the output stream:

| Hook                      | What it reports                                                                                        |
| ------------------------- | ------------------------------------------------------------------------------------------------------ |
| `onSemanticPrompt`        | OSC 133 prompt marks (`prompt-start`, `input-start`, `output-start`, `command-end` with the exit code) |
| `onPwdChange`             | OSC 7 as sent: the raw `file://host/path` URI                                                          |
| `onDesktopNotification`   | OSC 9 and OSC 777 notifications                                                                        |
| `onUnknownOsc`            | OSCs Ghostty does not implement, e.g. `633;E;…`                                                        |
| `onBell`, `onTitleChange` | Ghostty's own bell and title                                                                           |
| `clipboardWriteHandler`   | Decides OSC 52 writes (denied unless it returns true); reads are never answered                        |
| `registerMarker(offset)`  | An xterm.js-style marker that follows its line through scrolling and reflow                            |
| `modes.mouseTrackingMode` | `none`, `x10`, `vt200`, `drag` or `any`                                                                |

The render loop runs only while something changes (output, input, scrolling, selection, cursor
blink) and sleeps otherwise. `setPaused(true)` stops drawing a terminal that is off screen while it
keeps parsing output; `setPaused(false)` redraws it whole. `setPaused(true, { releaseRenderer: true })`
also gives up its WebGL context until then, since browsers keep only a few.

## Use

```ts
import { Ghostty, Terminal, FitAddon } from '@aurigax-ai/ghostty-web';

const ghostty = await Ghostty.fromBytes(wasmBytes);
const term = new Terminal({ ghostty, fontSize: 14 });
const fit = new FitAddon();
term.loadAddon(fit);
term.open(element);
fit.fit();
term.onData((data) => pty.write(data));
pty.onData((data) => term.write(data));
```

## Release

Raise `version` in `package.json`, commit, and push a matching `v<version>` tag. `release.yml`
rebuilds the WASM, checks it matches the committed file, runs the tests and publishes to npm with
trusted publishing (no token). A version with a `-` (e.g. `0.2.0-rc.1`) is published under the
`next` tag.

## License

MIT. See [LICENSE](./LICENSE). Ghostty is MIT licensed by Mitchell Hashimoto and the Ghostty
contributors.
