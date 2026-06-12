#!/usr/bin/env node
// Builds the official, signed (and optionally notarized) DMG of the menu bar
// app for browser-download distribution. Maintainer-only — users on npm get
// the prebuilt binary through `menubar install` and never need this.
//
//   node scripts/build-dmg.js [--identity "Developer ID Application: …"]
//                             [--notary-profile <keychain-profile>]
//
// - identity: defaults to the first "Developer ID Application" identity in
//   the keychain. Distribution REQUIRES Developer ID — an "Apple Development"
//   cert signs successfully but Gatekeeper rejects it on other machines
//   (pass it explicitly to test the pipeline).
// - notary-profile: a profile stored once via
//     xcrun notarytool store-credentials <name> --apple-id you@x --team-id T…
//   Without it the DMG is signed but NOT notarized: macOS 15+ refuses
//   un-notarized browser downloads outright, so notarize before publishing.
//
// The DMG app ships WITHOUT a baked config.json — it discovers the npm
// package + node at runtime (see discoverConfig() in menubar/main.swift) and
// tells the user to `npm install -g ai-acct-autopilot` if missing.
'use strict';
const { execFileSync } = require('node:child_process');
const fs = require('node:fs');
const path = require('node:path');

const ROOT = path.join(__dirname, '..');
const VERSION = require(path.join(ROOT, 'package.json')).version;
const DIST = path.join(ROOT, 'dist');
const STAGE = path.join(DIST, 'stage');
const APP = path.join(STAGE, 'AI Acct Autopilot.app');
const DMG = path.join(DIST, `AI-Acct-Autopilot-${VERSION}.dmg`);

const arg = (name) => {
  const i = process.argv.indexOf(name);
  return i >= 0 ? process.argv[i + 1] : null;
};
const sh = (cmd, args, opts = {}) => execFileSync(cmd, args, { encoding: 'utf8', stdio: opts.quiet ? 'pipe' : 'inherit', ...opts });

if (process.platform !== 'darwin') { console.error('build-dmg: macOS only'); process.exit(1); }

let identity = arg('--identity') || process.env.AI_ACCT_SIGN_IDENTITY;
if (!identity) {
  const ids = execFileSync('security', ['find-identity', '-v', '-p', 'codesigning'], { encoding: 'utf8' });
  const m = ids.match(/"(Developer ID Application: [^"]+)"/);
  if (!m) {
    console.error('build-dmg: no "Developer ID Application" identity in the keychain.');
    console.error('Create one at developer.apple.com → Certificates (paid membership account),');
    console.error('download + double-click it, then re-run. Identities present now:');
    console.error(ids.trim());
    process.exit(1);
  }
  identity = m[1];
}
const notaryProfile = arg('--notary-profile') || process.env.AI_ACCT_NOTARY_PROFILE || null;

console.log(`build-dmg: signing as "${identity}"${notaryProfile ? `, notarizing with profile "${notaryProfile}"` : ' (NOT notarizing — macOS 15+ blocks un-notarized downloads)'}`);

// 1. universal binary (reuses the prepack builder)
sh(process.execPath, [path.join(__dirname, 'build-menubar.js')]);

// 2. assemble the standalone bundle — no config.json on purpose
fs.rmSync(STAGE, { recursive: true, force: true });
fs.mkdirSync(path.join(APP, 'Contents', 'MacOS'), { recursive: true });
fs.mkdirSync(path.join(APP, 'Contents', 'Resources'), { recursive: true });
fs.copyFileSync(path.join(ROOT, 'menubar', 'prebuilt', 'AIAcctAutopilot'), path.join(APP, 'Contents', 'MacOS', 'AIAcctAutopilot'));
fs.chmodSync(path.join(APP, 'Contents', 'MacOS', 'AIAcctAutopilot'), 0o755);
// keep in sync with menubarInfoPlist() in bin/ai-acct-autopilot.js
fs.writeFileSync(path.join(APP, 'Contents', 'Info.plist'), `<?xml version="1.0" encoding="UTF-8"?>
<!DOCTYPE plist PUBLIC "-//Apple//DTD PLIST 1.0//EN" "http://www.apple.com/DTDs/PropertyList-1.0.dtd">
<plist version="1.0"><dict>
  <key>CFBundleIdentifier</key><string>com.ai-acct-autopilot.menubar</string>
  <key>CFBundleName</key><string>AI Acct Autopilot</string>
  <key>CFBundleExecutable</key><string>AIAcctAutopilot</string>
  <key>CFBundlePackageType</key><string>APPL</string>
  <key>CFBundleShortVersionString</key><string>${VERSION}</string>
  <key>LSUIElement</key><true/>
  <key>NSHighResolutionCapable</key><true/>
  <key>NSAppleEventsUsageDescription</key><string>Opens the terminal dashboard in Terminal.app when you ask for it.</string>
</dict></plist>
`);

// 3. sign with hardened runtime (notarization requirement)
sh('codesign', ['--force', '--deep', '--options', 'runtime', '--timestamp', '-s', identity, APP]);
sh('codesign', ['--verify', '--strict', '--verbose=2', APP]);

// 4. DMG with the classic drag-to-install layout (app + /Applications link)
fs.symlinkSync('/Applications', path.join(STAGE, 'Applications'));
fs.rmSync(DMG, { force: true });
sh('hdiutil', ['create', '-volname', 'AI Acct Autopilot', '-srcfolder', STAGE, '-ov', '-format', 'UDZO', DMG]);
sh('codesign', ['--force', '--timestamp', '-s', identity, DMG]);

// 5. notarize + staple
if (notaryProfile) {
  console.log('build-dmg: submitting to Apple notary service (takes a few minutes)…');
  sh('xcrun', ['notarytool', 'submit', DMG, '--keychain-profile', notaryProfile, '--wait']);
  sh('xcrun', ['stapler', 'staple', DMG]);
  console.log('build-dmg: notarized + stapled — Gatekeeper-clean for browser downloads.');
}

fs.rmSync(STAGE, { recursive: true, force: true });
console.log(`build-dmg: ${DMG}`);
