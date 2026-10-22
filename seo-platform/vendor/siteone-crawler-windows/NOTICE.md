# Vendored siteone-crawler binary (Windows)

- Upstream: https://github.com/janreges/siteone-crawler (MIT License, Copyright (c) 2023-2026 Ján Regeš — see `LICENSE` in this directory).
- Downloaded directly from the project's official GitHub release
  (`siteone-crawler-v2.5.1-win-x64.zip`, release `v2.5.1`), not built
  from source — unlike the Linux binary in `vendor/siteone-crawler/`,
  which was built from source in Phase 3 because GitHub release
  downloads were unreachable from that sandbox. A direct Windows
  machine has normal internet access, so the official release asset
  was used here instead.
- Binary: `siteone-crawler.exe` (PE32+ x86_64, ~24MB). Version reported:
  `2.5.1.20260627` — note this is a slightly older release than the
  Linux binary's dev build (`2.7.0.20260925-dev`), since that one was
  built from the latest main branch. Functionally compatible for this
  project's purposes (same JSON report schema); revisit if a future
  phase depends on a feature only in the newer build.
- Used automatically on Windows (`process.platform === "win32"`) by
  `src/lib/crawler-adapter.ts`'s `resolveBinaryPath()` — see that
  file and `docs/INTEGRATION_ARCHITECTURE.md` for how platform
  selection works. `CRAWLER_BIN_PATH` still overrides both.
