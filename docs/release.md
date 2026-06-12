# Release checklist

Use this before tagging a public release. The DMG path is intentionally gated:
do not tag until the Developer ID and Apple notarization secrets are present,
or the GitHub release will publish without a downloadable DMG.

## Required GitHub secrets

`NPM_TOKEN` publishes the npm package. These five secrets are required for the
public DMG:

- `MACOS_CERTIFICATE_BASE64`: base64 of the Developer ID Application `.p12`
- `MACOS_CERTIFICATE_PASSWORD`: password for that `.p12`
- `APPLE_ID`: Apple ID used for notarization
- `APPLE_TEAM_ID`: Apple Developer team ID
- `APPLE_APP_SPECIFIC_PASSWORD`: app-specific password for `notarytool`

The release workflow also accepts the existing desktop-app convention used in
the other macOS projects in this account:

- `APPLE_CERTIFICATE` instead of `MACOS_CERTIFICATE_BASE64`
- `APPLE_CERTIFICATE_PASSWORD` instead of `MACOS_CERTIFICATE_PASSWORD`
- `APPLE_PASSWORD` instead of `APPLE_APP_SPECIFIC_PASSWORD`

Create the certificate secret from a local `.p12` without printing it. Use the
existing desktop-app names if you want this repo to match the other projects:

```bash
base64 -i DeveloperIDApplication.p12 | gh secret set APPLE_CERTIFICATE --repo alnimra/ai-acct-autopilot
gh secret set APPLE_CERTIFICATE_PASSWORD --repo alnimra/ai-acct-autopilot
gh secret set APPLE_ID --repo alnimra/ai-acct-autopilot
gh secret set APPLE_TEAM_ID --repo alnimra/ai-acct-autopilot
gh secret set APPLE_PASSWORD --repo alnimra/ai-acct-autopilot
```

Or use the repo-specific names:

```bash
base64 -i DeveloperIDApplication.p12 | gh secret set MACOS_CERTIFICATE_BASE64 --repo alnimra/ai-acct-autopilot
gh secret set MACOS_CERTIFICATE_PASSWORD --repo alnimra/ai-acct-autopilot
gh secret set APPLE_ID --repo alnimra/ai-acct-autopilot
gh secret set APPLE_TEAM_ID --repo alnimra/ai-acct-autopilot
gh secret set APPLE_APP_SPECIFIC_PASSWORD --repo alnimra/ai-acct-autopilot
```

Verify the secret names, not their values:

```bash
gh secret list --repo alnimra/ai-acct-autopilot
```

The list must include `NPM_TOKEN`, `APPLE_ID`, `APPLE_TEAM_ID`, and either the
`MACOS_CERTIFICATE_*`/`APPLE_APP_SPECIFIC_PASSWORD` set or the
`APPLE_CERTIFICATE`/`APPLE_CERTIFICATE_PASSWORD`/`APPLE_PASSWORD` set before
tagging.

Having an Apple Developer membership in Xcode is not enough by itself for this
command-line release path. `security find-identity -v -p codesigning` must show
a `Developer ID Application: ...` identity locally, or the equivalent `.p12`
must be available as a GitHub secret.

## Local preflight

Run these from the repo root:

```bash
git status --short --branch
npm test
npm pack --dry-run
xcrun notarytool store-credentials aaa-notary --apple-id you@example.com --team-id TEAMID
npm run build:dmg -- --identity "Developer ID Application: Your Name (TEAMID)" --notary-profile aaa-notary
spctl -a -vv -t open dist/AI-Acct-Autopilot-*.dmg
```

For a public DMG, `spctl` must accept the artifact after notarization and
stapling. A local test build signed with `Apple Development`, or signed with
Developer ID but not notarized, proves packaging only; Gatekeeper rejects that
on download and it must not be published.

## Tag and watch

After `package.json` has the release version and CI is green on `main`:

```bash
git tag v1.1.2
git push origin v1.1.2
gh run list --repo alnimra/ai-acct-autopilot --workflow release --limit 1
gh run watch --repo alnimra/ai-acct-autopilot <run-id> --exit-status
```

## Post-release verification

Check the release assets:

```bash
gh release view v1.1.2 --repo alnimra/ai-acct-autopilot --json assets,url
```

The release must include:

- `ai-acct-autopilot-1.1.2.tgz`
- `AI-Acct-Autopilot-1.1.2.dmg`

Then download and verify the DMG:

```bash
gh release download v1.1.2 --repo alnimra/ai-acct-autopilot --pattern '*.dmg' --dir /tmp/ai-acct-autopilot-release
spctl -a -vv -t open /tmp/ai-acct-autopilot-release/AI-Acct-Autopilot-1.1.2.dmg
hdiutil attach -nobrowse -readonly /tmp/ai-acct-autopilot-release/AI-Acct-Autopilot-1.1.2.dmg
```

Inside the mounted app, confirm the bundled engine exists:

```bash
APP="/Volumes/AI Acct Autopilot/AI Acct Autopilot.app"
test -x "$APP/Contents/Resources/engine/bin/ai-acct-autopilot.js"
test -x "$APP/Contents/Resources/engine/bin/claude-acct"
test ! -f "$APP/Contents/Resources/config.json"
codesign --verify --strict --verbose=2 "$APP"
```
