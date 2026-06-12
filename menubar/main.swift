// AI Acct Autopilot — native macOS menu bar app (CodexBar-style).
//
// Compiled by `ai-acct-autopilot menubar install` with swiftc; zero
// dependencies beyond AppKit. The app is a thin shell:
//
//   • spawns `node bin/ai-acct-autopilot.js --menubar` and reads one JSON
//     snapshot per tick from its stdout (the node side owns ALL account,
//     autopilot, and switching logic — including the safety invariants),
//   • renders the snapshot as a status item ("✳ 82% ⌁ 64%" = % left for the
//     active Claude / Codex account) and a dropdown with per-account bars,
//   • shells back into the CLI for manual actions (codex-use, claude-acct use)
//     and pokes the child with SIGUSR2 to refresh.
//
// Tool paths come from Resources/config.json, baked at build time — launch
// agents start with no user PATH. Colors mirror the terminal palette: red
// means "needs the user", amber means "handled".

import AppKit
import Foundation

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
  static let dim = NSColor.tertiaryLabelColor
  static let text = NSColor.labelColor
}

// MARK: - Small helpers

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

func barText(_ used: Double?, width: Int = 10) -> String {
  let u = used ?? 0
  let filled = Int((u / 100 * Double(width)).rounded())
  return String(repeating: "█", count: max(0, min(width, filled)))
    + String(repeating: "░", count: max(0, width - filled))
}
func barColor(_ used: Double?) -> NSColor {
  guard let u = used else { return Palette.dim }
  return u >= 95 ? Palette.red : u >= 85 ? Palette.amber : Palette.tan
}
func leftColor(_ left: Double?, threshold: Double) -> NSColor {
  guard let l = left else { return Palette.grey }
  return l <= threshold ? Palette.red : l <= 15 ? Palette.amber : Palette.text
}

func attr(_ parts: [(String, NSColor)], size: CGFloat = 13, mono: Bool = true, bold: Bool = false) -> NSAttributedString {
  let font = mono
    ? NSFont.monospacedSystemFont(ofSize: size, weight: bold ? .semibold : .regular)
    : NSFont.menuFont(ofSize: size)
  let out = NSMutableAttributedString()
  for (text, color) in parts {
    out.append(NSAttributedString(string: text, attributes: [.font: font, .foregroundColor: color]))
  }
  return out
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

  var autopilotEnabled: Bool {
    get { UserDefaults.standard.object(forKey: "autopilotEnabled") as? Bool ?? true }
    set { UserDefaults.standard.set(newValue, forKey: "autopilotEnabled") }
  }

  func applicationDidFinishLaunching(_ note: Notification) {
    statusItem = NSStatusBar.system.statusItem(withLength: NSStatusItem.variableLength)
    menu.delegate = self
    statusItem.menu = menu
    statusItem.button?.attributedTitle = attr([("✳ … ⌁ …", Palette.grey)])
    loadConfig()
    spawnChild()
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

  // MARK: child process (the node watcher)

  func loadConfig() {
    let env = ProcessInfo.processInfo.environment
    let url = env["AI_ACCT_MENUBAR_CONFIG"].map { URL(fileURLWithPath: $0) }
      ?? Bundle.main.url(forResource: "config", withExtension: "json")
    guard let url = url, let data = try? Data(contentsOf: url),
          let cfg = try? JSONDecoder().decode(Config.self, from: data) else {
      configError = "config.json missing/unreadable — re-run: ai-acct-autopilot menubar install"
      return
    }
    config = cfg
  }

  func spawnChild() {
    guard let cfg = config else {
      statusItem.button?.attributedTitle = attr([("✳⌁ ⚠", Palette.amber)])
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
      statusItem.button?.attributedTitle = attr([("✳⌁ ⚠", Palette.amber)])
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
    statusItem.button?.attributedTitle = attr(parts, size: 12)
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
      menu.addItem(label([("▲ \(alert.text)", color)], mono: false))
    }
    if !s.alerts.isEmpty { menu.addItem(.separator()) }

    // ---- CLAUDE ----
    menu.addItem(header("CLAUDE"))
    if !s.claude.ok {
      menu.addItem(label([("claude-acct usage failed — retrying next tick", Palette.red)], mono: false))
    }
    for acct in s.claude.accounts {
      var title: [(String, NSColor)] = []
      title.append((acct.active ? "● " : "○ ", acct.active ? Palette.green : Palette.grey))
      title.append((acct.name, acct.active ? Palette.orange : Palette.text))
      if let sub = acct.subscription { title.append(("  \(sub)", Palette.grey)) }
      if acct.reauth { title.append(("  re-auth needed", Palette.amber)) }
      if acct.recovery { title.append(("  recovered snapshot", Palette.amber)) }
      menu.addItem(label(title, bold: true))
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
      menu.addItem(label([("no codex chatgpt login found (~/.codex/auth.json)", Palette.grey)], mono: false))
    }
    for acct in s.codex.accounts {
      var title: [(String, NSColor)] = []
      title.append((acct.active ? "● " : "○ ", acct.active ? Palette.green : Palette.grey))
      title.append((acct.email, acct.active ? Palette.orange : Palette.text))
      if acct.active, let plan = s.codex.plan { title.append(("  \(plan)", Palette.grey)) }
      if acct.dead { title.append(("  re-login needed", Palette.amber)) }
      if acct.active && !acct.saved { title.append(("  not snapshotted — codex-save", Palette.amber)) }
      menu.addItem(label(title, bold: true))
      addUsageRows(acct.rows, trend: acct.trend, threshold: s.threshold)
      if !acct.active && !acct.dead && acct.saved {
        let item = actionItem("      switch to \(acct.email)  (new sessions)", #selector(switchCodex(_:)))
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
          ("  \(name.padding(toLength: 7, withPad: " ", startingAt: 0))", color),
          ("\(money(p?.todayCost)) today · \(money(p?.cost30)) 30d · \(tok(p?.tokens30)) tok", Palette.text),
        ])
      }
      menu.addItem(labelAttr(statLine("CLAUDE", Palette.tan, stats.claude)))
      menu.addItem(labelAttr(statLine("CODEX", Palette.blue, stats.codex)))
    }
    if let progress = s.statsProgress {
      menu.addItem(label([("  \(progress)", Palette.grey)], mono: false))
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
        menu.addItem(label([("  \(when)  ", Palette.grey), (what, Palette.text)]))
      }
    }

    // ---- controls ----
    menu.addItem(.separator())
    let auto = NSMenuItem(
      title: s.mode == "auto" ? "Autopilot: switching at <\(Int(s.threshold))% left" : "Autopilot paused — monitor only",
      action: #selector(toggleAutopilot), keyEquivalent: "")
    auto.target = self
    auto.state = s.mode == "auto" ? .on : .off
    menu.addItem(auto)
    menu.addItem(actionItem("Refresh now", #selector(refreshNow), key: "r"))
    menu.addItem(actionItem("Open Terminal dashboard", #selector(openDashboard)))
    menu.addItem(.separator())
    let updated = parseISO(s.ts).map { f -> String in
      let df = DateFormatter()
      df.timeStyle = .medium
      return df.string(from: f)
    } ?? "—"
    menu.addItem(label([("updated \(updated) · checks every \(Int(s.interval))s", Palette.grey)], mono: false))
    menu.addItem(actionItem("Quit", #selector(quit), key: "q"))
  }

  func addUsageRows(_ rows: [UsageRow], trend: String?, threshold: Double) {
    if rows.isEmpty {
      menu.addItem(label([("      ··········  usage unknown", Palette.grey)]))
      return
    }
    for row in rows {
      let left: Double? = row.used == nil ? nil : (100 - row.used!).rounded()
      let leftText = left == nil ? "–" : "\(Int(left!))% left"
      let reset = relative(row.resetsAt).map { "resets \($0)" } ?? "no active window"
      menu.addItem(labelAttr(attr([
        ("      \(row.label.padding(toLength: 7, withPad: " ", startingAt: 0))", Palette.grey),
        (barText(row.used), barColor(row.used)),
        ("  \(leftText.padding(toLength: 10, withPad: " ", startingAt: 0))", leftColor(left, threshold: threshold)),
        (" \(reset)", Palette.grey),
      ])))
    }
    if let trend = trend, !trend.isEmpty {
      menu.addItem(labelAttr(attr([
        ("      trend  ", Palette.grey), (trend, Palette.tan), ("  5h window", Palette.grey),
      ])))
    }
  }

  // MARK: menu item helpers

  func header(_ text: String) -> NSMenuItem {
    let item = NSMenuItem()
    item.attributedTitle = attr([("\(text)", Palette.grey)], size: 11, bold: true)
    item.isEnabled = false
    return item
  }
  func label(_ parts: [(String, NSColor)], mono: Bool = true, bold: Bool = false) -> NSMenuItem {
    let item = NSMenuItem()
    item.attributedTitle = attr(parts, mono: mono, bold: bold)
    item.isEnabled = false
    return item
  }
  func labelAttr(_ a: NSAttributedString) -> NSMenuItem {
    let item = NSMenuItem()
    item.attributedTitle = a
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
  @objc func toggleAutopilot() {
    autopilotEnabled.toggle()
    restartChild()
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
