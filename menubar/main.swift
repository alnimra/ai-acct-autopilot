// AI Acct Autopilot — native macOS menu bar app (CodexBar-style).
//
// Compiled by `ai-acct-autopilot menubar install` with swiftc (npm installs
// use the prebuilt universal binary instead); zero dependencies beyond
// AppKit. The app is a thin shell:
//
//   • spawns `node bin/ai-acct-autopilot.js --menubar` and reads one JSON
//     snapshot per tick from its stdout (the node side owns ALL account,
//     autopilot, and switching logic — including the safety invariants),
//   • renders the snapshot as a status item ("✳ 82% ⌁ 64%" = % left for the
//     active Claude / Codex account) and a dropdown with per-account bars,
//   • shells back into the CLI for manual actions (codex-use, claude-acct
//     use, codex-shim install) and pokes the child with SIGUSR2 to refresh.
//
// Tool paths come from Resources/config.json (baked at build time by the
// CLI installer — launch agents get no user PATH). When there is no config
// (the standalone DMG build), the app uses its bundled CLI engine first, then
// falls back to a global npm install.
// Colors mirror the terminal palette: red means "needs the user", amber
// means "handled".

import AppKit
import Foundation
import ServiceManagement

// MARK: - Snapshot model (mirrors menubarSnapshot() in bin/ai-acct-autopilot.js)

struct UsageRow: Decodable {
  let label: String
  let key: String
  let used: Double?
  let resetsAt: String?
}
struct ClaudeAccount: Decodable {
  let name: String
  let email: String?
  let subscription: String?
  let active: Bool
  let recovery: Bool
  let reauth: Bool
  let rows: [UsageRow]
  let percentLeft: Double?
  let trend: String?
}
struct CodexAccount: Decodable {
  let email: String
  let active: Bool
  let saved: Bool
  let dead: Bool
  let rows: [UsageRow]
  let percentLeft: Double?
  let trend: String?
}
struct ClaudeSection: Decodable {
  let ok: Bool
  let active: String?
  let accounts: [ClaudeAccount]
}
struct CodexSection: Decodable {
  let active: String?
  let plan: String?
  let accounts: [CodexAccount]
}
struct SnapshotAlert: Decodable {
  let level: String
  let text: String
  let action: String?
}
struct ProviderStats: Decodable {
  let todayCost: Double?
  let cost30: Double?
  let tokens30: Double?
  let lastTokens: Double?
  let topModel: String?
}
struct Stats: Decodable {
  let claude: ProviderStats?
  let codex: ProviderStats?
}
struct JournalEvent: Decodable {
  let ts: String?
  let provider: String?
  let event: String?
  let from: String?
  let to: String?
  let reason: String?
  let account: String?
}
struct Snapshot: Decodable {
  let v: Int
  let ts: String
  let mode: String
  let threshold: Double
  let interval: Double
  let attention: String
  let alerts: [SnapshotAlert]
  let claude: ClaudeSection
  let codex: CodexSection
  let stats: Stats?
  let statsProgress: String?
  let events: [JournalEvent]
}

struct Config: Decodable {
  let node: String
  let script: String
  let claudeAcct: String
  let version: String?
  let builtAt: String?
}

// MARK: - Palette (terminal colors from the CLI dashboard)

enum Palette {
  static let tan = NSColor(red: 232 / 255, green: 160 / 255, blue: 76 / 255, alpha: 1)
  static let blue = NSColor(red: 96 / 255, green: 165 / 255, blue: 250 / 255, alpha: 1)
  static let orange = NSColor(red: 249 / 255, green: 117 / 255, blue: 78 / 255, alpha: 1)
  static let amber = NSColor(red: 249 / 255, green: 191 / 255, blue: 1 / 255, alpha: 1)
  static let red = NSColor(red: 233 / 255, green: 59 / 255, blue: 35 / 255, alpha: 1)
  static let green = NSColor(red: 82 / 255, green: 178 / 255, blue: 138 / 255, alpha: 1)
  static let grey = NSColor.secondaryLabelColor
  static let text = NSColor.labelColor
}

// MARK: - Small helpers

let MENU_W: CGFloat = 380

let isoFracFormatter: ISO8601DateFormatter = {
  let f = ISO8601DateFormatter()
  f.formatOptions = [.withInternetDateTime, .withFractionalSeconds]
  return f
}()
let isoFormatter: ISO8601DateFormatter = ISO8601DateFormatter()

func parseISO(_ s: String?) -> Date? {
  guard let s = s else { return nil }
  return isoFracFormatter.date(from: s) ?? isoFormatter.date(from: s)
}

// "in 2h 10m" / "3d 4h ago" — same shape as the terminal's rel()
func relative(_ iso: String?) -> String? {
  guard let date = parseISO(iso) else { return nil }
  var s = Int(date.timeIntervalSinceNow.rounded())
  let past = s < 0
  s = abs(s)
  let d = s / 86400, h = (s % 86400) / 3600, m = (s % 3600) / 60
  let txt = d > 0 ? "\(d)d \(h)h" : h > 0 ? "\(h)h \(String(format: "%02d", m))m" : "\(m)m"
  return past ? "\(txt) ago" : "in \(txt)"
}

func barColor(_ used: Double?) -> NSColor {
  guard let u = used else { return NSColor.quaternaryLabelColor }
  return u >= 95 ? Palette.red : u >= 85 ? Palette.amber : Palette.tan
}
func leftColor(_ left: Double?, threshold: Double) -> NSColor {
  guard let l = left else { return Palette.grey }
  return l <= threshold ? Palette.red : l <= 15 ? Palette.amber : Palette.text
}

func attr(_ parts: [(String, NSColor)], size: CGFloat = 13, mono: Bool = false, weight: NSFont.Weight = .regular) -> NSAttributedString {
  let font = mono
    ? NSFont.monospacedSystemFont(ofSize: size, weight: weight)
    : NSFont.systemFont(ofSize: size, weight: weight)
  let out = NSMutableAttributedString()
  for (text, color) in parts {
    out.append(NSAttributedString(string: text, attributes: [.font: font, .foregroundColor: color]))
  }
  return out
}

func field(_ s: String, size: CGFloat, weight: NSFont.Weight, color: NSColor, mono: Bool = false) -> NSTextField {
  let t = NSTextField(labelWithString: s)
  t.font = mono ? NSFont.monospacedSystemFont(ofSize: size, weight: weight) : NSFont.systemFont(ofSize: size, weight: weight)
  t.textColor = color
  t.lineBreakMode = .byTruncatingTail
  return t
}

// Rounded usage bar drawn natively — replaces the old █░ ASCII bars
final class BarView: NSView {
  var used: Double?
  init(used: Double?, frame: NSRect) {
    self.used = used
    super.init(frame: frame)
  }
  required init?(coder: NSCoder) { fatalError() }
  override func draw(_ dirtyRect: NSRect) {
    let h: CGFloat = 6
    let y = (bounds.height - h) / 2
    NSColor.quaternaryLabelColor.setFill()
    NSBezierPath(roundedRect: NSRect(x: 0, y: y, width: bounds.width, height: h), xRadius: h / 2, yRadius: h / 2).fill()
    if let u = used {
      let w = max(h, bounds.width * CGFloat(min(100, max(0, u))) / 100)
      barColor(u).setFill()
      NSBezierPath(roundedRect: NSRect(x: 0, y: y, width: w, height: h), xRadius: h / 2, yRadius: h / 2).fill()
    }
  }
}

// MARK: - App

@main
final class AppDelegate: NSObject, NSApplicationDelegate, NSMenuDelegate {
  static func main() {
    let app = NSApplication.shared
    let delegate = AppDelegate()
    app.delegate = delegate
    app.setActivationPolicy(.accessory)
    app.run()
  }

  var statusItem: NSStatusItem!
  let menu = NSMenu()
  var config: Config?
  var configError: String?
  var child: Process?
  var lineBuffer = Data()
  var snapshot: Snapshot?
  var quitting = false
  var restarting = false
  var standalone = false // no baked config: the DMG drag-install case
  weak var tickerItem: NSMenuItem?

  var autopilotEnabled: Bool {
    get { UserDefaults.standard.object(forKey: "autopilotEnabled") as? Bool ?? true }
    set { UserDefaults.standard.set(newValue, forKey: "autopilotEnabled") }
  }

  func applicationDidFinishLaunching(_ note: Notification) {
    statusItem = NSStatusBar.system.statusItem(withLength: NSStatusItem.variableLength)
    menu.delegate = self
    statusItem.menu = menu
    statusItem.button?.attributedTitle = attr([("✳ … ⌁ …", Palette.grey)], size: 12, mono: true)
    loadConfig()
    spawnChild()
    // live ticker: updates the footer countdown every second, including while
    // the menu is open (.common covers the menu-tracking run loop mode)
    let timer = Timer(timeInterval: 1, repeats: true) { [weak self] _ in self?.updateTicker() }
    RunLoop.main.add(timer, forMode: .common)
    // QA hook: pop the menu open for a screenshot run (value = delay seconds,
    // long enough for the first probe tick to land); never set in production
    if let raw = ProcessInfo.processInfo.environment["AI_ACCT_MENUBAR_DEBUG_OPEN"] {
      let delay = Double(raw) ?? 6
      DispatchQueue.main.asyncAfter(deadline: .now() + delay) { [weak self] in
        self?.statusItem.button?.performClick(nil)
      }
    }
  }

  func applicationWillTerminate(_ note: Notification) {
    quitting = true
    child?.terminate()
  }

  // MARK: config — baked by the installer, or discovered at runtime (DMG build)

  func loadConfig() {
    let env = ProcessInfo.processInfo.environment
    let url = env["AI_ACCT_MENUBAR_CONFIG"].map { URL(fileURLWithPath: $0) }
      ?? Bundle.main.url(forResource: "config", withExtension: "json")
    if let url = url, let data = try? Data(contentsOf: url),
       let cfg = try? JSONDecoder().decode(Config.self, from: data) {
      config = cfg
      return
    }
    if let cfg = discoverConfig() {
      config = cfg
      standalone = true
      return
    }
    standalone = true
    configError = "Node.js not found — install Node 18+ or run: npm install -g ai-acct-autopilot"
  }

  // The standalone DMG app finds its bundled CLI engine + node on its own.
  func discoverConfig() -> Config? {
    let fm = FileManager.default
    let home = NSHomeDirectory()
    let resolve = { (p: String) -> String in (try? fm.destinationOfSymbolicLink(atPath: p)).map {
      $0.hasPrefix("/") ? $0 : ((p as NSString).deletingLastPathComponent as NSString).appendingPathComponent($0)
    } ?? p }
    let discoverNode = { () -> String? in
      if let node = ["/opt/homebrew/bin/node", "/usr/local/bin/node"].first(where: { fm.isExecutableFile(atPath: $0) }) {
        return node
      }
      return self.shellWhich("node")
    }
    if let resources = Bundle.main.resourceURL?.path {
      let bundledScript = resources + "/engine/bin/ai-acct-autopilot.js"
      let bundledClaudeAcct = resources + "/engine/bin/claude-acct"
      if fm.fileExists(atPath: bundledScript), let node = discoverNode() {
        return Config(node: node, script: bundledScript, claudeAcct: bundledClaudeAcct, version: nil, builtAt: nil)
      }
    }
    var script: String?
    for c in [
      "/opt/homebrew/lib/node_modules/ai-acct-autopilot/bin/ai-acct-autopilot.js",
      "/usr/local/lib/node_modules/ai-acct-autopilot/bin/ai-acct-autopilot.js",
      home + "/.local/bin/ai-acct-autopilot",
    ] where fm.fileExists(atPath: c) { script = resolve(c); break }
    if script == nil, let w = shellWhich("ai-acct-autopilot") { script = resolve(w) }
    let node = discoverNode()
    guard let s = script, let n = node else { return nil }
    let scriptDir = (s as NSString).deletingLastPathComponent
    let claudeAcct = [home + "/.local/bin/claude-acct", scriptDir + "/claude-acct"]
      .first { fm.fileExists(atPath: $0) } ?? "claude-acct"
    return Config(node: n, script: s, claudeAcct: claudeAcct, version: nil, builtAt: nil)
  }

  func shellWhich(_ cmd: String) -> String? {
    let proc = Process()
    proc.executableURL = URL(fileURLWithPath: "/bin/zsh")
    proc.arguments = ["-lc", "command -v \(cmd)"]
    let pipe = Pipe()
    proc.standardOutput = pipe
    proc.standardError = FileHandle.nullDevice
    guard (try? proc.run()) != nil else { return nil }
    proc.waitUntilExit()
    let out = String(data: pipe.fileHandleForReading.readDataToEndOfFile(), encoding: .utf8)?
      .trimmingCharacters(in: .whitespacesAndNewlines)
    return (out?.isEmpty ?? true) ? nil : out
  }

  // MARK: child process (the node watcher)

  func spawnChild() {
    guard let cfg = config else {
      statusItem.button?.attributedTitle = attr([("✳⌁ ⚠", Palette.amber)], size: 12, mono: true)
      return
    }
    let proc = Process()
    proc.executableURL = URL(fileURLWithPath: cfg.node)
    var args = [cfg.script, "--menubar"]
    if !autopilotEnabled { args.append("--no-switch") }
    if let extra = ProcessInfo.processInfo.environment["AI_ACCT_MENUBAR_EXTRA_ARGS"] {
      args += extra.split(separator: " ").map(String.init)
    }
    proc.arguments = args
    var env = ProcessInfo.processInfo.environment
    let toolDir = (cfg.claudeAcct as NSString).deletingLastPathComponent
    let nodeDir = (cfg.node as NSString).deletingLastPathComponent
    env["PATH"] = "\(toolDir):\(nodeDir):" + (env["PATH"] ?? "/usr/bin:/bin:/usr/sbin:/sbin")
    proc.environment = env

    let pipe = Pipe()
    proc.standardOutput = pipe
    proc.standardError = FileHandle.nullDevice
    pipe.fileHandleForReading.readabilityHandler = { [weak self] handle in
      let data = handle.availableData
      if data.isEmpty { return }
      DispatchQueue.main.async { self?.consume(data) }
    }
    proc.terminationHandler = { [weak self] _ in
      DispatchQueue.main.async {
        guard let self = self, !self.quitting else { return }
        pipe.fileHandleForReading.readabilityHandler = nil
        if self.restarting {
          self.restarting = false
          self.spawnChild()
        } else {
          // crashed / killed: show stale state, come back in 3s
          DispatchQueue.main.asyncAfter(deadline: .now() + 3) { self.spawnChild() }
        }
      }
    }
    do {
      try proc.run()
      child = proc
    } catch {
      configError = "failed to launch node: \(error.localizedDescription)"
      statusItem.button?.attributedTitle = attr([("✳⌁ ⚠", Palette.amber)], size: 12, mono: true)
    }
  }

  func restartChild() {
    guard let proc = child, proc.isRunning else { spawnChild(); return }
    restarting = true
    proc.terminate()
  }

  func consume(_ data: Data) {
    lineBuffer.append(data)
    while let nl = lineBuffer.firstIndex(of: 0x0A) {
      let line = lineBuffer.subdata(in: lineBuffer.startIndex..<nl)
      lineBuffer.removeSubrange(lineBuffer.startIndex...nl)
      guard !line.isEmpty else { continue }
      if let snap = try? JSONDecoder().decode(Snapshot.self, from: line) {
        snapshot = snap
        updateStatusTitle()
      }
    }
  }

  // MARK: status item title — "✳ 82% ⌁ 64%" (% left, active accounts)

  func updateStatusTitle() {
    guard let s = snapshot else { return }
    let claudeLeft = s.claude.accounts.first(where: { $0.active })?.percentLeft
    let codexLeft = s.codex.accounts.first(where: { $0.active })?.percentLeft
    let pctText = { (v: Double?) in v == nil ? "–" : "\(Int(v!))%" }
    var parts: [(String, NSColor)] = []
    if s.attention != "ok" {
      parts.append(("▲ ", s.attention == "red" ? Palette.red : Palette.amber))
    }
    parts.append(("✳ ", Palette.grey))
    parts.append((pctText(claudeLeft), leftColor(claudeLeft, threshold: s.threshold)))
    if s.codex.active != nil {
      parts.append((" ⌁ ", Palette.grey))
      parts.append((pctText(codexLeft), leftColor(codexLeft, threshold: s.threshold)))
    }
    statusItem.button?.attributedTitle = attr(parts, size: 12, mono: true)
  }

  // MARK: live footer ticker — "updated 17:05:12 · next check in 42s"

  func tickerText() -> NSAttributedString {
    guard let s = snapshot else { return attr([("starting…", Palette.grey)], size: 11) }
    var line = "—"
    if let updated = parseISO(s.ts) {
      let df = DateFormatter()
      df.timeStyle = .medium
      let secs = Int(updated.addingTimeInterval(s.interval).timeIntervalSinceNow.rounded())
      line = "updated \(df.string(from: updated)) · " + (secs > 0 ? "next check in \(secs)s" : "checking…")
    }
    if let cfg = config, cfg.version != nil || cfg.builtAt != nil {
      let built = parseISO(cfg.builtAt).map { d -> String in
        let df = DateFormatter()
        df.dateFormat = "MMM d HH:mm"
        return df.string(from: d)
      }
      line += " · v\(cfg.version ?? "?")\(built.map { ", built \($0)" } ?? "")"
    }
    return attr([(line, Palette.grey)], size: 11)
  }

  func updateTicker() {
    tickerItem?.attributedTitle = tickerText()
  }

  // MARK: menu

  func menuNeedsUpdate(_ menu: NSMenu) {
    menu.removeAllItems()
    if let err = configError {
      menu.addItem(label([("⚠ \(err)", Palette.amber)]))
      menu.addItem(.separator())
      menu.addItem(actionItem("Quit", #selector(quit), key: "q"))
      return
    }
    guard let s = snapshot else {
      menu.addItem(label([("starting watcher — first tick can take a few seconds…", Palette.grey)]))
      menu.addItem(.separator())
      menu.addItem(actionItem("Quit", #selector(quit), key: "q"))
      return
    }

    for alert in s.alerts {
      let color = alert.level == "red" ? Palette.red : Palette.amber
      menu.addItem(label([("▲ \(alert.text)", color)]))
      if alert.action == "install-shim" {
        menu.addItem(actionItem("    Install the codex shim now", #selector(installShim)))
      }
    }
    if !s.alerts.isEmpty { menu.addItem(.separator()) }

    // ---- CLAUDE ----
    menu.addItem(header("CLAUDE"))
    if !s.claude.ok {
      menu.addItem(label([("claude-acct usage failed — retrying next tick", Palette.red)]))
    }
    for acct in s.claude.accounts {
      var meta: [(String, NSColor)] = []
      if let sub = acct.subscription { meta.append((sub, Palette.grey)) }
      if acct.reauth { meta.append(("re-auth needed", Palette.amber)) }
      if acct.recovery { meta.append(("recovered snapshot", Palette.amber)) }
      menu.addItem(viewItem(accountRow(dotColor: acct.active ? Palette.green : NSColor.quaternaryLabelColor,
        name: acct.name, nameColor: acct.active ? Palette.orange : Palette.text, meta: meta)))
      addUsageRows(acct.rows, trend: acct.trend, threshold: s.threshold)
      if !acct.active && !acct.recovery {
        let item = actionItem("      switch to \(acct.name)", #selector(switchClaude(_:)))
        item.representedObject = acct.name
        menu.addItem(item)
      }
    }

    // ---- CODEX ----
    menu.addItem(.separator())
    menu.addItem(header("CODEX"))
    if s.codex.active == nil {
      menu.addItem(label([("no codex chatgpt login found (~/.codex/auth.json)", Palette.grey)]))
    }
    for acct in s.codex.accounts {
      var meta: [(String, NSColor)] = []
      if acct.active, let plan = s.codex.plan { meta.append((plan, Palette.grey)) }
      if acct.dead { meta.append(("re-login needed", Palette.amber)) }
      if acct.active && !acct.saved { meta.append(("not snapshotted — codex-save", Palette.amber)) }
      menu.addItem(viewItem(accountRow(dotColor: acct.active ? Palette.green : NSColor.quaternaryLabelColor,
        name: acct.email, nameColor: acct.active ? Palette.orange : Palette.text, meta: meta)))
      addUsageRows(acct.rows, trend: acct.trend, threshold: s.threshold)
      if !acct.active && !acct.dead && acct.saved {
        // supervised running sessions auto-resume on the new account; the
        // shim alert above covers the unshimmed case
        let item = actionItem("      switch to \(acct.email)", #selector(switchCodex(_:)))
        item.representedObject = acct.email
        menu.addItem(item)
      }
    }

    // ---- local usage (est. API rates) ----
    if let stats = s.stats {
      menu.addItem(.separator())
      menu.addItem(header("LOCAL USAGE · EST. API RATES · ALL ACCOUNTS"))
      let money = { (v: Double?) in v == nil ? "—" : String(format: "$%.2f", v!) }
      let tok = { (v: Double?) -> String in
        guard let n = v else { return "—" }
        if n >= 1e9 { return String(format: "%.1fB", n / 1e9) }
        if n >= 1e6 { return String(format: "%.1fM", n / 1e6) }
        if n >= 1e3 { return String(format: "%.0fK", n / 1e3) }
        return String(format: "%.0f", n)
      }
      let statLine = { (name: String, color: NSColor, p: ProviderStats?) -> NSAttributedString in
        attr([
          ("\(name)  ", color),
          ("\(money(p?.todayCost)) today · \(money(p?.cost30)) 30d · \(tok(p?.tokens30)) tokens", Palette.text),
        ], size: 12, weight: .medium)
      }
      menu.addItem(labelAttr(statLine("CLAUDE", Palette.tan, stats.claude), indent: true))
      menu.addItem(labelAttr(statLine("CODEX ", Palette.blue, stats.codex), indent: true))
    }
    if let progress = s.statsProgress {
      menu.addItem(label([("  \(progress)", Palette.grey)], size: 11))
    }

    // ---- recent events ----
    let events = s.events.prefix(3)
    if !events.isEmpty {
      menu.addItem(.separator())
      for e in events {
        let when: String
        if let d = parseISO(e.ts) {
          let f = DateFormatter()
          f.dateFormat = "MMM d HH:mm"
          when = f.string(from: d)
        } else { when = "—" }
        let prov = (e.provider ?? "claude") == "claude" ? "" : "\(e.provider ?? "") "
        let what: String
        switch e.event {
        case "switch": what = "\(prov)\(e.from ?? "?") → \(e.to ?? "?")"
        case "all-hot": what = "\(prov)all accounts hot — held"
        case "snapshot": what = "re-snapshotted \(e.account ?? "?")"
        case "switch-failed": what = "\(prov)switch FAILED \(e.from ?? "?") → \(e.to ?? "?")"
        default: what = "\(prov)\(e.event ?? "?")"
        }
        menu.addItem(label([("  \(when)  ", Palette.grey), (what, Palette.text)], size: 12))
      }
    }

    // ---- controls ----
    menu.addItem(.separator())
    // instant state from defaults — the child restart (and its first tick)
    // lags behind the click; "applying…" marks the gap
    let applying = (s.mode == "auto") != autopilotEnabled
    let auto = NSMenuItem(
      title: autopilotEnabled
        ? "Autopilot: switching at <\(Int(s.threshold))% left\(applying ? "  (applying…)" : "")"
        : "Autopilot paused — monitor only\(applying ? "  (applying…)" : "")",
      action: #selector(toggleAutopilot), keyEquivalent: "")
    auto.target = self
    auto.state = autopilotEnabled ? .on : .off
    menu.addItem(auto)
    menu.addItem(actionItem("Refresh now", #selector(refreshNow), key: "r"))
    menu.addItem(actionItem("Open Terminal dashboard", #selector(openDashboard)))
    // drag-installed (DMG) copies have no LaunchAgent — offer the native
    // login-item registration instead; npm installs already start at login
    if standalone, #available(macOS 13.0, *) {
      let login = NSMenuItem(title: "Start at login", action: #selector(toggleLoginItem), keyEquivalent: "")
      login.target = self
      login.state = SMAppService.mainApp.status == .enabled ? .on : .off
      menu.addItem(login)
    }
    menu.addItem(.separator())
    let ticker = NSMenuItem()
    ticker.attributedTitle = tickerText()
    ticker.isEnabled = false
    menu.addItem(ticker)
    tickerItem = ticker
    menu.addItem(actionItem("Quit", #selector(quit), key: "q"))
  }

  // MARK: view-based rows (native typography + drawn bars)

  func viewItem(_ view: NSView) -> NSMenuItem {
    let item = NSMenuItem()
    item.view = view
    return item
  }

  func accountRow(dotColor: NSColor, name: String, nameColor: NSColor, meta: [(String, NSColor)]) -> NSView {
    let v = NSView(frame: NSRect(x: 0, y: 0, width: MENU_W, height: 24))
    let dot = field("●", size: 10, weight: .regular, color: dotColor)
    dot.frame = NSRect(x: 14, y: 5, width: 14, height: 14)
    v.addSubview(dot)
    let nameField = field(name, size: 13, weight: .semibold, color: nameColor)
    nameField.frame = NSRect(x: 30, y: 3, width: 210, height: 18)
    v.addSubview(nameField)
    var x: CGFloat = 30 + min(206, nameField.attributedStringValue.size().width + 8)
    for (text, color) in meta {
      let m = field(text, size: 11, weight: .medium, color: color)
      let w = m.attributedStringValue.size().width + 4
      m.frame = NSRect(x: x, y: 4.5, width: min(w, MENU_W - x - 12), height: 15)
      v.addSubview(m)
      x += w + 6
      if x > MENU_W - 20 { break }
    }
    return v
  }

  func usageRow(_ row: UsageRow, threshold: Double) -> NSView {
    let v = NSView(frame: NSRect(x: 0, y: 0, width: MENU_W, height: 21))
    let left: Double? = row.used == nil ? nil : (100 - row.used!).rounded()
    let label = field(row.label, size: 11, weight: .medium, color: Palette.grey)
    label.frame = NSRect(x: 30, y: 3, width: 48, height: 15)
    v.addSubview(label)
    let bar = BarView(used: row.used, frame: NSRect(x: 80, y: 0, width: 110, height: 21))
    v.addSubview(bar)
    let leftText = left == nil ? "–" : "\(Int(left!))% left"
    let leftField = field(leftText, size: 12, weight: .semibold, color: leftColor(left, threshold: threshold))
    leftField.frame = NSRect(x: 200, y: 2.5, width: 70, height: 16)
    v.addSubview(leftField)
    let reset = relative(row.resetsAt).map { "resets \($0)" } ?? "no active window"
    let resetField = field(reset, size: 11, weight: .regular, color: Palette.grey)
    resetField.alignment = .right
    resetField.frame = NSRect(x: 268, y: 3, width: MENU_W - 268 - 14, height: 15)
    v.addSubview(resetField)
    return v
  }

  func addUsageRows(_ rows: [UsageRow], trend: String?, threshold: Double) {
    if rows.isEmpty {
      menu.addItem(label([("      usage unknown", Palette.grey)], size: 12))
      return
    }
    for row in rows {
      menu.addItem(viewItem(usageRow(row, threshold: threshold)))
    }
    if let trend = trend, !trend.isEmpty {
      let v = NSView(frame: NSRect(x: 0, y: 0, width: MENU_W, height: 18))
      let label = field("trend", size: 11, weight: .medium, color: Palette.grey)
      label.frame = NSRect(x: 30, y: 1, width: 48, height: 15)
      v.addSubview(label)
      let spark = field(trend, size: 11, weight: .regular, color: Palette.tan, mono: true)
      spark.frame = NSRect(x: 80, y: 1, width: 200, height: 15)
      v.addSubview(spark)
      let suffix = field("5h window", size: 11, weight: .regular, color: Palette.grey)
      suffix.alignment = .right
      suffix.frame = NSRect(x: 268, y: 1, width: MENU_W - 268 - 14, height: 15)
      v.addSubview(suffix)
      menu.addItem(viewItem(v))
    }
  }

  // MARK: menu item helpers

  func header(_ text: String) -> NSMenuItem {
    let item = NSMenuItem()
    item.attributedTitle = attr([("\(text)", Palette.grey)], size: 11, weight: .semibold)
    item.isEnabled = false
    return item
  }
  func label(_ parts: [(String, NSColor)], size: CGFloat = 13) -> NSMenuItem {
    let item = NSMenuItem()
    item.attributedTitle = attr(parts, size: size)
    item.isEnabled = false
    return item
  }
  func labelAttr(_ a: NSAttributedString, indent: Bool = false) -> NSMenuItem {
    let item = NSMenuItem()
    if indent {
      let m = NSMutableAttributedString(string: "  ")
      m.append(a)
      item.attributedTitle = m
    } else {
      item.attributedTitle = a
    }
    item.isEnabled = false
    return item
  }
  func actionItem(_ title: String, _ action: Selector, key: String = "") -> NSMenuItem {
    let item = NSMenuItem(title: title, action: action, keyEquivalent: key)
    item.target = self
    return item
  }

  // MARK: actions

  func runTool(_ exe: String, _ args: [String]) {
    let proc = Process()
    proc.executableURL = URL(fileURLWithPath: exe)
    proc.arguments = args
    proc.standardOutput = FileHandle.nullDevice
    proc.standardError = FileHandle.nullDevice
    proc.terminationHandler = { [weak self] _ in
      DispatchQueue.main.async { self?.refreshNow() }
    }
    try? proc.run()
  }

  @objc func switchClaude(_ sender: NSMenuItem) {
    guard let cfg = config, let name = sender.representedObject as? String else { return }
    runTool(cfg.claudeAcct, ["use", name])
  }
  @objc func switchCodex(_ sender: NSMenuItem) {
    guard let cfg = config, let email = sender.representedObject as? String else { return }
    runTool(cfg.node, [cfg.script, "codex-use", email])
  }
  @objc func installShim() {
    guard let cfg = config else { return }
    runTool(cfg.node, [cfg.script, "codex-shim", "install"])
  }
  @objc func toggleAutopilot() {
    autopilotEnabled.toggle()
    restartChild()
  }
  @objc func toggleLoginItem() {
    if #available(macOS 13.0, *) {
      let svc = SMAppService.mainApp
      if svc.status == .enabled { try? svc.unregister() } else { try? svc.register() }
    }
  }
  @objc func refreshNow() {
    // SIGUSR2: SIGUSR1 would start node's inspector
    if let proc = child, proc.isRunning { kill(proc.processIdentifier, SIGUSR2) }
  }
  @objc func openDashboard() {
    guard let cfg = config else { return }
    let shq = { (s: String) in "'" + s.replacingOccurrences(of: "'", with: "'\\''") + "'" }
    let cmd = "clear; \(shq(cfg.node)) \(shq(cfg.script))"
    let asEscaped = cmd
      .replacingOccurrences(of: "\\", with: "\\\\")
      .replacingOccurrences(of: "\"", with: "\\\"")
    let script = "tell application \"Terminal\"\nactivate\ndo script \"\(asEscaped)\"\nend tell"
    let proc = Process()
    proc.executableURL = URL(fileURLWithPath: "/usr/bin/osascript")
    proc.arguments = ["-e", script]
    try? proc.run()
  }
  @objc func quit() {
    NSApp.terminate(nil)
  }
}
