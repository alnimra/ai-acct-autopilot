#!/bin/sh
# ai-acct-autopilot installer (no npm needed): symlinks the commands into
# ~/.local/bin. Run from a clone of the repo.
set -e
DIR="$(cd "$(dirname "$0")" && pwd)"
mkdir -p "$HOME/.local/bin"
ln -sf "$DIR/bin/ai-acct-autopilot.js" "$HOME/.local/bin/ai-acct-autopilot"
ln -sf "$DIR/bin/claude-acct" "$HOME/.local/bin/claude-acct"
chmod +x "$DIR/bin/ai-acct-autopilot.js" "$DIR/bin/claude-acct"
echo "installed: ai-acct-autopilot, claude-acct -> ~/.local/bin"
case ":$PATH:" in
  *":$HOME/.local/bin:"*) ;;
  *) echo "NOTE: add ~/.local/bin to your PATH." ;;
esac
echo "next steps:"
echo "  claude-acct save <your-email>            # capture your current Claude account"
echo "  ai-acct-autopilot codex-save             # capture your current Codex account"
echo "  ai-acct-autopilot codex-shim install     # enable codex session auto-resume"
echo "  ai-acct-autopilot                        # run the dashboard"
