#!/usr/bin/env node
// Builds the prebuilt universal (arm64 + x86_64) menubar binary that ships in
// the npm tarball, so `ai-acct-autopilot menubar install` needs no Xcode on
// user machines. Runs at `npm pack` / `npm publish` time (prepack) on the
// maintainer's Mac or CI — never on a user install.
//
// Fail-open by design: no macOS or no swiftc → warn and exit 0, so packing a
// git checkout without Xcode still succeeds; `menubar install` then falls
// back to compiling locally.
//
// The signature is AD-HOC (`codesign -s -`): npm-extracted files carry no
// quarantine attribute, so Gatekeeper never prompts, and ad-hoc satisfies
// Apple Silicon's signed-code requirement. No Apple Developer ID needed.
'use strict';
const { execFileSync } = require('node:child_process');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');

const SRC = path.join(__dirname, '..', 'menubar', 'main.swift');
const OUT_DIR = path.join(__dirname, '..', 'menubar', 'prebuilt');
const OUT = path.join(OUT_DIR, 'AIAcctAutopilot');
// macOS 12 floor: every AppKit/Foundation API the app uses predates it, and
// the OS ships the ABI-stable Swift runtime.
const TARGET_OS = 'apple-macosx12.0';

if (process.platform !== 'darwin') {
  console.warn('build-menubar: not macOS — skipping prebuilt binary');
  process.exit(0);
}
try {
  execFileSync('xcrun', ['-sdk', 'macosx', '--find', 'swiftc'], { stdio: 'ignore' });
} catch {
  console.warn('build-menubar: swiftc unavailable — skipping prebuilt binary');
  console.warn('(menubar install will compile from source on the user machine)');
  process.exit(0);
}

fs.mkdirSync(OUT_DIR, { recursive: true });
const tmp = fs.mkdtempSync(path.join(os.tmpdir(), 'aaa-menubar-build-'));
try {
  const slices = [];
  for (const arch of ['arm64', 'x86_64']) {
    const slice = path.join(tmp, arch);
    execFileSync('xcrun', ['-sdk', 'macosx', 'swiftc', '-O', '-parse-as-library',
      '-target', `${arch}-${TARGET_OS}`, '-o', slice, SRC], { stdio: 'inherit' });
    slices.push(slice);
  }
  execFileSync('xcrun', ['lipo', '-create', ...slices, '-output', OUT], { stdio: 'inherit' });
  execFileSync('codesign', ['--force', '-s', '-', OUT], { stdio: 'inherit' });
  const archs = execFileSync('xcrun', ['lipo', '-archs', OUT], { encoding: 'utf8' }).trim();
  const kb = Math.round(fs.statSync(OUT).size / 1024);
  console.log(`build-menubar: built ${OUT} (${archs}, ${kb} KB, ad-hoc signed)`);
} finally {
  fs.rmSync(tmp, { recursive: true, force: true });
}
