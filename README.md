# ostia-ghostty

[Ghostty](https://github.com/ghostty-org/ghostty)'s terminal engine in the browser, with an
[xterm.js](https://github.com/xtermjs/xterm.js)-shaped API and a canvas renderer. It is the engine
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
- **pnpm and Vitest** instead of Bun; no demo server, benchmark or release automation.

## Build

Needs [Zig](https://ziglang.org) 0.16.0 and pnpm.

```sh
pnpm install
pnpm build:wasm   # clones Ghostty at GHOSTTY_COMMIT into vendor/ and builds ghostty-vt.wasm
pnpm test
pnpm build        # dist/ with the library and the WASM
```

libghostty-vt's API is not stable yet, so `GHOSTTY_COMMIT` is raised on purpose, with the tests as
the guard.

## Use

```ts
import { Ghostty, Terminal, FitAddon } from '@aurigax-ai/ostia-ghostty';

const ghostty = await Ghostty.fromBytes(wasmBytes);
const term = new Terminal({ ghostty, fontSize: 14 });
const fit = new FitAddon();
term.loadAddon(fit);
term.open(element);
fit.fit();
term.onData((data) => pty.write(data));
pty.onData((data) => term.write(data));
```

## License

MIT. See [LICENSE](./LICENSE). Ghostty is MIT licensed by Mitchell Hashimoto and the Ghostty
contributors.
