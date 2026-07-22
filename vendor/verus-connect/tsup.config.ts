import { defineConfig } from 'tsup';

export default defineConfig([
  // ── Node entries: library + server middleware + CLI ──
  {
    entry: {
      index: 'src/index.ts',
      server: 'src/server.ts',
      cli: 'src/cli.ts',
    },
    format: ['esm', 'cjs'],
    dts: true,
    clean: true,
    sourcemap: false,
    // verusid-ts-client is a lazy peer dep used only by lite mode. It must
    // stay external so the bundled ESM build does a runtime require rather
    // than inlining its CJS internals (which use `__filename` / `__dirname`
    // and break in an ESM context).
    external: ['verusid-ts-client'],
    // Lite mode (`signer-lite.ts`) does a dynamic `require('verusid-ts-client')`
    // so callers can install that peer dep only when they need lite mode. In
    // ESM output that would normally throw "Dynamic require not supported".
    // The banner gives the ESM bundle a working `require` via Node's
    // `createRequire`, which lets the dynamic load resolve from node_modules
    // as expected.
    banner: (ctx) => {
      if (ctx.format === 'esm') {
        return {
          js: `import { createRequire as __cjsRequire } from 'module'; const require = __cjsRequire(import.meta.url);`,
        };
      }
      return {};
    },
  },
  // ── Browser entry: <verus-connect-login> custom element ──
  // ESM for bundler consumers (`import 'verus-connect/web'`), IIFE for
  // plain `<script src>` drops. qrcode is bundled inline so the published
  // file is self-contained.
  {
    entry: { web: 'src/web/index.ts' },
    format: ['esm', 'iife'],
    globalName: 'VerusConnectWeb',
    platform: 'browser',
    target: 'es2020',
    dts: true,
    clean: false,
    sourcemap: false,
    minify: true,
    noExternal: ['qrcode'],
  },
]);
