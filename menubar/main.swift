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
//   • shells back into the CLI app-action contract for manual actions
//     (including account removal) and pokes the child with SIGUSR2 to refresh.
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
  let usageStatus: Int?
  let usageMessage: String?
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
struct ReadinessItem: Decodable {
  let id: String
  let level: String
  let text: String
  let action: String?
}
struct Readiness: Decodable {
  let status: String
  let primaryAction: String?
  let items: [ReadinessItem]
  let complete: Bool
}
struct ShimState: Decodable {
  let status: String
  let message: String
  let action: String?
}
struct UpdateState: Decodable {
  let currentVersion: String?
  let latestVersion: String?
  let available: Bool
  let releaseUrl: String?
  let downloadUrl: String?
  let checkedAt: String?
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
  let readiness: Readiness?
  let shim: ShimState?
  let update: UpdateState?
  let stats: Stats?
  let statsProgress: String?
  let events: [JournalEvent]
}

struct AppActionResult: Decodable {
  let ok: Bool
  let action: String
  let provider: String?
  let message: String
  let changed: Bool
  let needsRefresh: Bool
  let userActionRequired: Bool
  let errorCode: String?
  let stderrTail: String?
  let data: AppActionData?
}
struct AppActionData: Decodable {
  let email: String?
  let account: String?
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
  static let claudeLogo = NSColor(red: 217 / 255, green: 119 / 255, blue: 87 / 255, alpha: 1)
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
func pctText(_ v: Double?) -> String {
  v == nil ? "–" : "\(Int(v!))%"
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

enum ProviderLogo {
  case claude
  case openAI

  var pathData: String {
    switch self {
    case .claude:
      return "m19.6 66.5 19.7-11 .3-1-.3-.5h-1l-3.3-.2-11.2-.3L14 53l-9.5-.5-2.4-.5L0 49l.2-1.5 2-1.3 2.9.2 6.3.5 9.5.6 6.9.4L38 49.1h1.6l.2-.7-.5-.4-.4-.4L29 41l-10.6-7-5.6-4.1-3-2-1.5-2-.6-4.2 2.7-3 3.7.3.9.2 3.7 2.9 8 6.1L37 36l1.5 1.2.6-.4.1-.3-.7-1.1L33 25l-6-10.4-2.7-4.3-.7-2.6c-.3-1-.4-2-.4-3l3-4.2L28 0l4.2.6L33.8 2l2.6 6 4.1 9.3L47 29.9l2 3.8 1 3.4.3 1h.7v-.5l.5-7.2 1-8.7 1-11.2.3-3.2 1.6-3.8 3-2L61 2.6l2 2.9-.3 1.8-1.1 7.7L59 27.1l-1.5 8.2h.9l1-1.1 4.1-5.4 6.9-8.6 3-3.5L77 13l2.3-1.8h4.3l3.1 4.7-1.4 4.9-4.4 5.6-3.7 4.7-5.3 7.1-3.2 5.7.3.4h.7l12-2.6 6.4-1.1 7.6-1.3 3.5 1.6.4 1.6-1.4 3.4-8.2 2-9.6 2-14.3 3.3-.2.1.2.3 6.4.6 2.8.2h6.8l12.6 1 3.3 2 1.9 2.7-.3 2-5.1 2.6-6.8-1.6-16-3.8-5.4-1.3h-.8v.4l4.6 4.5 8.3 7.5L89 80.1l.5 2.4-1.3 2-1.4-.2-9.2-7-3.6-3-8-6.8h-.5v.7l1.8 2.7 9.8 14.7.5 4.5-.7 1.4-2.6 1-2.7-.6-5.8-8-6-9-4.7-8.2-.5.4-2.9 30.2-1.3 1.5-3 1.2-2.5-2-1.4-3 1.4-6.2 1.6-8 1.3-6.4 1.2-7.9.7-2.6v-.2H49L43 72l-9 12.3-7.2 7.6-1.7.7-3-1.5.3-2.8L24 86l10-12.8 6-7.9 4-4.6-.1-.5h-.3L17.2 77.4l-4.7.6-2-2 .2-3 1-1 8-5.5Z"
    case .openAI:
      return "M123.2,118.3V85c0-2.2,0.6-3.8,2.9-5.1L187.9,44c8.3-4.8,18.9-7,29.2-7c39.1,0,63.8,30.1,63.8,62.5c0,2.6,0,6.1-0.6,9l-64.7-37.8c-3.2-1.9-6.7-2.2-10.6,0L123.2,118.3z M266.1,236.6v-74c0-4.2-1.6-7-5.4-9.3l-82-47.7l28.8-16.7c1.6-1,4.2-1,5.8,0l62.2,35.9c17.6,10.3,29.8,32.7,29.8,54.1C305.2,204.2,289.8,227.6,266.1,236.6z M106.2,172.8l-28.5-17c-2.2-1.3-2.9-2.9-2.9-5.1V79.3c0-34.9,26.6-61.2,62.8-61.2c14.1,0,27.6,4.8,38.4,13.5L111.7,69c-3.8,2.2-5.4,5.1-5.4,9.3V172.8z M162,204.9l-38.8-21.8v-46.1l38.8-21.8l38.4,21.8v46.1L162,204.9z M186,301.9c-14.1,0-27.6-4.8-38.4-13.5L212,251c3.8-2.2,5.4-5.1,5.4-9.3v-94.5l28.8,17c2.2,1.3,2.9,2.9,2.9,5.1v71.5C249.1,275.7,222.2,301.9,186,301.9z M110.4,231.1l-62.2-35.9c-17.6-10.3-29.8-32.7-29.8-54.1c0-25.6,15.7-48.7,39.4-57.7v74.3c0,4.2,1.6,7,5.4,9.3l81.7,47.4l-28.8,16.7C114.6,232.1,112,232.1,110.4,231.1z M106.5,283c-36.8,0-63.8-27.6-63.8-61.8c0-3.2,0.3-6.4,0.6-9.3l64.4,37.2c3.8,2.2,7,2.2,10.9,0l81.7-47.4V235c0,2.2-0.6,3.8-2.9,5.1L135.7,276C127.4,280.8,116.8,283,106.5,283z M186,319.2c38.4,0,70.5-27.6,77.5-64.1c35.9-9,59-42.3,59-76.3c0-22.4-9.6-43.9-27.2-59.6c1.6-6.7,2.9-13.8,2.9-20.5c0-45.2-36.8-79.1-79.1-79.1c-8.7,0-17.3,1.6-25.6,4.5C179,9.7,159.4,0.8,137.6,0.8c-38.4,0-70.5,27.6-77.5,64.1c-35.9,9-59,42.3-59,76.3c0,22.4,9.6,43.9,27.2,59.6c-1.6,6.7-2.9,13.8-2.9,20.5c0,45.2,36.8,79.1,79.1,79.1c8.7,0,17.3-1.6,25.6-4.5C144.7,310.3,164.2,319.2,186,319.2z"
    }
  }

  var color: NSColor {
    switch self {
    case .claude: return Palette.claudeLogo
    case .openAI: return Palette.text
    }
  }
}

struct SVGPathParser {
  let bytes: [UInt8]
  var index = 0
  var command: UInt8 = 0
  var current = CGPoint.zero
  var subpathStart = CGPoint.zero
  var path = NSBezierPath()

  init(_ data: String) {
    bytes = Array(data.utf8)
  }

  mutating func parse() -> NSBezierPath {
    while true {
      skipSeparators()
      if index >= bytes.count { break }
      if isCommand(bytes[index]) {
        command = bytes[index]
        index += 1
      } else if command == 0 {
        break
      }
      parseCommand(command)
    }
    return path
  }

  mutating func parseCommand(_ raw: UInt8) {
    let relative = raw >= 97 && raw <= 122
    let cmd = raw >= 97 && raw <= 122 ? raw - 32 : raw
    switch cmd {
    case 77: // M
      guard let first = readPoint(relative: relative) else { return }
      path.move(to: first)
      current = first
      subpathStart = first
      while canReadNumber(), let p = readPoint(relative: relative) {
        path.line(to: p)
        current = p
      }
    case 76: // L
      while canReadNumber(), let p = readPoint(relative: relative) {
        path.line(to: p)
        current = p
      }
    case 72: // H
      while canReadNumber(), let x = readNumber() {
        current = CGPoint(x: relative ? current.x + x : x, y: current.y)
        path.line(to: current)
      }
    case 86: // V
      while canReadNumber(), let y = readNumber() {
        current = CGPoint(x: current.x, y: relative ? current.y + y : y)
        path.line(to: current)
      }
    case 67: // C
      while canReadNumber(),
            let x1 = readNumber(), let y1 = readNumber(),
            let x2 = readNumber(), let y2 = readNumber(),
            let x = readNumber(), let y = readNumber() {
        let c1 = CGPoint(x: relative ? current.x + x1 : x1, y: relative ? current.y + y1 : y1)
        let c2 = CGPoint(x: relative ? current.x + x2 : x2, y: relative ? current.y + y2 : y2)
        let end = CGPoint(x: relative ? current.x + x : x, y: relative ? current.y + y : y)
        path.curve(to: end, controlPoint1: c1, controlPoint2: c2)
        current = end
      }
    case 90: // Z
      path.close()
      current = subpathStart
    default:
      return
    }
  }

  mutating func readPoint(relative: Bool) -> CGPoint? {
    guard let x = readNumber(), let y = readNumber() else { return nil }
    return relative ? CGPoint(x: current.x + x, y: current.y + y) : CGPoint(x: x, y: y)
  }

  mutating func readNumber() -> CGFloat? {
    skipSeparators()
    if index >= bytes.count || isCommand(bytes[index]) { return nil }
    let start = index
    if bytes[index] == 45 || bytes[index] == 43 { index += 1 }
    while index < bytes.count && isDigit(bytes[index]) { index += 1 }
    if index < bytes.count && bytes[index] == 46 {
      index += 1
      while index < bytes.count && isDigit(bytes[index]) { index += 1 }
    }
    if index < bytes.count && (bytes[index] == 101 || bytes[index] == 69) {
      index += 1
      if index < bytes.count && (bytes[index] == 45 || bytes[index] == 43) { index += 1 }
      while index < bytes.count && isDigit(bytes[index]) { index += 1 }
    }
    guard index > start,
          let number = Double(String(decoding: bytes[start..<index], as: UTF8.self)) else {
      return nil
    }
    return CGFloat(number)
  }

  mutating func skipSeparators() {
    while index < bytes.count {
      let b = bytes[index]
      if b == 44 || b == 32 || b == 9 || b == 10 || b == 13 { index += 1 } else { break }
    }
  }

  mutating func canReadNumber() -> Bool {
    skipSeparators()
    return index < bytes.count && !isCommand(bytes[index])
  }

  func isCommand(_ b: UInt8) -> Bool {
    (b >= 65 && b <= 90) || (b >= 97 && b <= 122)
  }

  func isDigit(_ b: UInt8) -> Bool {
    b >= 48 && b <= 57
  }
}

func providerLogoPath(_ logo: ProviderLogo) -> NSBezierPath {
  var parser = SVGPathParser(logo.pathData)
  return parser.parse()
}

func drawProviderLogo(_ logo: ProviderLogo, in rect: NSRect, color: NSColor? = nil) {
  let path = providerLogoPath(logo)
  let b = path.bounds
  guard b.width > 0, b.height > 0 else { return }
  let insetRect = rect.insetBy(dx: rect.width * 0.06, dy: rect.height * 0.06)
  let scale = min(insetRect.width / b.width, insetRect.height / b.height)
  let w = b.width * scale
  let h = b.height * scale
  let x = insetRect.midX - w / 2
  let y = insetRect.midY - h / 2
  var transform = AffineTransform()
  transform.translate(x: x - b.minX * scale, y: y + b.maxY * scale)
  transform.scale(x: scale, y: -scale)
  let fitted = path.copy() as! NSBezierPath
  fitted.transform(using: transform)
  (color ?? logo.color).setFill()
  fitted.fill()
}

func providerLogoImage(_ logo: ProviderLogo, size: CGFloat, color: NSColor? = nil) -> NSImage {
  let image = NSImage(size: NSSize(width: size, height: size), flipped: false) { rect in
    drawProviderLogo(logo, in: rect, color: color)
    return true
  }
  image.isTemplate = false
  return image
}

func statusBarImage(claudeLeft: Double?, codexLeft: Double?, showCodex: Bool, threshold: Double) -> NSImage {
  let font = NSFont.monospacedSystemFont(ofSize: 12, weight: .semibold)
  let icon: CGFloat = 13
  let height: CGFloat = 18
  let iconGap: CGFloat = 3
  let segmentGap: CGFloat = 7
  let textAttrs: (NSColor) -> [NSAttributedString.Key: Any] = { color in
    [.font: font, .foregroundColor: color]
  }
  let claudeText = pctText(claudeLeft)
  let codexText = pctText(codexLeft)
  let claudeW = (claudeText as NSString).size(withAttributes: textAttrs(leftColor(claudeLeft, threshold: threshold))).width
  let codexW = showCodex ? (codexText as NSString).size(withAttributes: textAttrs(leftColor(codexLeft, threshold: threshold))).width : 0
  let width = ceil(icon + iconGap + claudeW + (showCodex ? segmentGap + icon + iconGap + codexW : 0))
  let image = NSImage(size: NSSize(width: width, height: height), flipped: false) { rect in
    var x: CGFloat = 0
    let drawText = { (text: String, color: NSColor, x: CGFloat) in
      let attrs = textAttrs(color)
      let size = (text as NSString).size(withAttributes: attrs)
      (text as NSString).draw(at: NSPoint(x: x, y: (rect.height - size.height) / 2 - 0.5), withAttributes: attrs)
      return size.width
    }
    drawProviderLogo(.claude, in: NSRect(x: x, y: (rect.height - icon) / 2, width: icon, height: icon))
    x += icon + iconGap
    x += drawText(claudeText, leftColor(claudeLeft, threshold: threshold), x)
    if showCodex {
      x += segmentGap
      drawProviderLogo(.openAI, in: NSRect(x: x, y: (rect.height - icon) / 2, width: icon, height: icon))
      x += icon + iconGap
      _ = drawText(codexText, leftColor(codexLeft, threshold: threshold), x)
    }
    return true
  }
  image.isTemplate = false
  return image
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
  var refreshProcess: Process?
  var refreshCompletions: [(Bool) -> Void] = []
  var actionProcess: Process?
  var lineBuffer = Data()
  var snapshot: Snapshot?
  var quitting = false
  var restarting = false
  var standalone = false // no baked config: the DMG drag-install case
  var manageAccountsWindow: ManageAccountsWindowController?
  weak var tickerItem: NSMenuItem?
  var ignoreSnapshotsBefore: Date?
  var watcherError: String?

  var autopilotEnabled: Bool {
    get { UserDefaults.standard.object(forKey: "autopilotEnabled") as? Bool ?? true }
    set { UserDefaults.standard.set(newValue, forKey: "autopilotEnabled") }
  }

  func applicationDidFinishLaunching(_ note: Notification) {
    if enforceSingleInstance() { return }
    statusItem = NSStatusBar.system.statusItem(withLength: NSStatusItem.variableLength)
    menu.delegate = self
    statusItem.menu = menu
    setStatusImage(claudeLeft: nil, codexLeft: nil, showCodex: true, threshold: 10, tooltip: "Claude – · OpenAI –")
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

  func enforceSingleInstance() -> Bool {
    let env = ProcessInfo.processInfo.environment
    if env["AI_ACCT_ALLOW_MULTIPLE"] != nil { return false }

    let bundleId = Bundle.main.bundleIdentifier ?? "com.ai-acct-autopilot.menubar"
    let currentPath = Bundle.main.bundlePath
    let installedPath = "/Applications/AI Acct Autopilot.app"
    let installedURL = URL(fileURLWithPath: installedPath)

    if currentPath.hasPrefix("/Volumes/"),
       FileManager.default.fileExists(atPath: installedPath),
       currentPath != installedPath {
      let config = NSWorkspace.OpenConfiguration()
      NSWorkspace.shared.openApplication(at: installedURL, configuration: config) { _, _ in
        DispatchQueue.main.async { NSApp.terminate(nil) }
      }
      return true
    }

    let pid = ProcessInfo.processInfo.processIdentifier
    for app in NSRunningApplication.runningApplications(withBundleIdentifier: bundleId)
      where app.processIdentifier != pid {
      app.terminate()
    }
    return false
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
      for node in ["/opt/homebrew/bin/node", "/usr/local/bin/node"] where fm.isExecutableFile(atPath: node) {
        if self.nodeMajorVersion(node).map({ $0 >= 18 }) == true { return node }
      }
      if let node = self.shellWhich("node"), self.nodeMajorVersion(node).map({ $0 >= 18 }) == true {
        return node
      }
      return nil
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

  func nodeMajorVersion(_ node: String) -> Int? {
    let proc = Process()
    proc.executableURL = URL(fileURLWithPath: node)
    proc.arguments = ["-p", "process.versions.node.split('.')[0]"]
    let pipe = Pipe()
    proc.standardOutput = pipe
    proc.standardError = FileHandle.nullDevice
    guard (try? proc.run()) != nil else { return nil }
    proc.waitUntilExit()
    guard proc.terminationStatus == 0 else { return nil }
    let out = String(data: pipe.fileHandleForReading.readDataToEndOfFile(), encoding: .utf8)?
      .trimmingCharacters(in: .whitespacesAndNewlines)
    return out.flatMap(Int.init)
  }

  // MARK: child process (the node watcher)

  func spawnChild() {
    guard let cfg = config else {
      setStatusImage(claudeLeft: nil, codexLeft: nil, showCodex: true, threshold: 10, tooltip: "AI Acct Autopilot needs setup")
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
    var env = toolEnvironment(cfg)
    env["AI_ACCT_MENUBAR_PARENT_PID"] = "\(ProcessInfo.processInfo.processIdentifier)"
    proc.environment = env

    let pipe = Pipe()
    proc.standardOutput = pipe
    let errPipe = Pipe()
    proc.standardError = errPipe
    pipe.fileHandleForReading.readabilityHandler = { [weak self] handle in
      let data = handle.availableData
      if data.isEmpty { return }
      DispatchQueue.main.async { self?.consume(data) }
    }
    proc.terminationHandler = { [weak self] finished in
      let errText = String(data: errPipe.fileHandleForReading.readDataToEndOfFile(), encoding: .utf8)?
        .trimmingCharacters(in: .whitespacesAndNewlines)
      DispatchQueue.main.async {
        guard let self = self, !self.quitting else { return }
        pipe.fileHandleForReading.readabilityHandler = nil
        if self.restarting {
          self.restarting = false
          self.spawnChild()
        } else {
          let detail: String
          if let errText = errText, !errText.isEmpty {
            detail = errText.split(separator: "\n").suffix(3).joined(separator: "\n")
          } else {
            detail = "exit status \(finished.terminationStatus)"
          }
          self.watcherError = "watcher exited — retrying: \(detail)"
          if self.snapshot == nil {
            self.setStatusImage(claudeLeft: nil, codexLeft: nil, showCodex: true, threshold: 10, tooltip: self.watcherError)
          }
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
      setStatusImage(claudeLeft: nil, codexLeft: nil, showCodex: true, threshold: 10, tooltip: configError)
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
        applySnapshot(snap)
      }
    }
  }

  func applySnapshot(_ snap: Snapshot, force: Bool = false) {
    if !force, let cutoff = ignoreSnapshotsBefore, let ts = parseISO(snap.ts), ts < cutoff {
      return
    }
    watcherError = nil
    snapshot = snap
    updateStatusTitle()
    maybePromptUpdate(snap)
    manageAccountsWindow?.update(snapshot: snap)
  }

  func snapshotCopy(_ s: Snapshot, claude: ClaudeSection? = nil, codex: CodexSection? = nil,
                    readiness: Readiness? = nil, shim: ShimState? = nil,
                    alerts: [SnapshotAlert]? = nil) -> Snapshot {
    Snapshot(v: s.v, ts: s.ts, mode: s.mode, threshold: s.threshold, interval: s.interval,
      attention: s.attention, alerts: alerts ?? s.alerts, claude: claude ?? s.claude,
      codex: codex ?? s.codex, readiness: readiness ?? s.readiness, shim: shim ?? s.shim,
      update: s.update, stats: s.stats, statsProgress: s.statsProgress, events: s.events)
  }

  func readinessRemovingActions(_ readiness: Readiness?, _ actions: Set<String>) -> Readiness? {
    guard let readiness = readiness else { return nil }
    let items = readiness.items.filter { item in
      guard let action = item.action else { return true }
      return !actions.contains(action)
    }
    let status = items.contains(where: { $0.level == "red" }) ? "red" : (items.isEmpty ? "ok" : "amber")
    let primary = readiness.primaryAction.flatMap { actions.contains($0) ? items.first?.action : $0 }
    return Readiness(status: status, primaryAction: primary, items: items, complete: items.isEmpty)
  }

  func alertsRemovingActions(_ alerts: [SnapshotAlert], _ actions: Set<String>) -> [SnapshotAlert] {
    alerts.filter { alert in
      guard let action = alert.action else { return true }
      return !actions.contains(action)
    }
  }

  func claudeSection(_ section: ClaudeSection, activating name: String, copyCurrentUsage: Bool) -> ClaudeSection {
    let current = section.accounts.first(where: { $0.active })
    var found = false
    var accounts = section.accounts.map { acct -> ClaudeAccount in
      if acct.name == name { found = true }
      return ClaudeAccount(name: acct.name, email: acct.email, subscription: acct.subscription,
        active: acct.name == name, recovery: acct.recovery, reauth: acct.reauth,
        rows: acct.rows, percentLeft: acct.percentLeft, trend: acct.trend,
        usageStatus: acct.usageStatus, usageMessage: acct.usageMessage)
    }
    if !found {
      let source = copyCurrentUsage ? current : nil
      accounts.insert(ClaudeAccount(name: name, email: source?.email, subscription: source?.subscription,
        active: true, recovery: false, reauth: false, rows: source?.rows ?? [],
        percentLeft: source?.percentLeft, trend: source?.trend,
        usageStatus: source?.usageStatus, usageMessage: source?.usageMessage), at: 0)
    }
    return ClaudeSection(ok: section.ok, active: name, accounts: accounts)
  }

  func codexSection(_ section: CodexSection, activating email: String) -> CodexSection {
    var found = false
    var accounts = section.accounts.map { acct -> CodexAccount in
      if acct.email == email { found = true }
      return CodexAccount(email: acct.email, active: acct.email == email, saved: acct.saved,
        dead: acct.dead, rows: acct.rows, percentLeft: acct.percentLeft, trend: acct.trend)
    }
    if !found {
      accounts.insert(CodexAccount(email: email, active: true, saved: true, dead: false,
        rows: [], percentLeft: nil, trend: nil), at: 0)
    }
    return CodexSection(active: email, plan: section.plan, accounts: accounts)
  }

  func codexSectionSavingActive(_ section: CodexSection) -> CodexSection {
    guard let active = section.active else { return section }
    var found = false
    var accounts = section.accounts.map { acct -> CodexAccount in
      if acct.email == active { found = true }
      return CodexAccount(email: acct.email, active: acct.active,
        saved: acct.email == active ? true : acct.saved,
        dead: acct.dead, rows: acct.rows, percentLeft: acct.percentLeft, trend: acct.trend)
    }
    if !found {
      accounts.insert(CodexAccount(email: active, active: true, saved: true, dead: false,
        rows: [], percentLeft: nil, trend: nil), at: 0)
    }
    return CodexSection(active: active, plan: section.plan, accounts: accounts)
  }

  func codexSectionAddingSaved(_ section: CodexSection, email: String) -> CodexSection {
    var found = false
    let accounts = section.accounts.map { acct -> CodexAccount in
      if acct.email == email { found = true }
      return CodexAccount(email: acct.email, active: acct.active,
        saved: acct.email == email ? true : acct.saved,
        dead: acct.email == email ? false : acct.dead,
        rows: acct.rows, percentLeft: acct.percentLeft, trend: acct.trend)
    }
    if found { return CodexSection(active: section.active, plan: section.plan, accounts: accounts) }
    let row = CodexAccount(email: email, active: false, saved: true, dead: false,
      rows: [], percentLeft: nil, trend: nil)
    return CodexSection(active: section.active, plan: section.plan, accounts: accounts + [row])
  }

  func optimisticallyApplyAction(_ action: String, value: String?, result: AppActionResult) {
    guard result.ok, let s = snapshot else { return }
    var next: Snapshot?
    switch action {
    case "claude-use":
      if let value = value {
        next = snapshotCopy(s, claude: claudeSection(s.claude, activating: value, copyCurrentUsage: false))
      }
    case "claude-save":
      if let value = value {
        next = snapshotCopy(s, claude: claudeSection(s.claude, activating: value, copyCurrentUsage: true))
      }
    case "claude-add":
      if let value = value {
        next = snapshotCopy(s, claude: claudeSection(s.claude, activating: value, copyCurrentUsage: false))
      }
    case "claude-remove":
      if let value = value {
        let accounts = s.claude.accounts.filter { $0.name != value }
        next = snapshotCopy(s, claude: ClaudeSection(ok: s.claude.ok, active: s.claude.active, accounts: accounts))
      }
    case "codex-use":
      if let value = value {
        next = snapshotCopy(s, codex: codexSection(s.codex, activating: value))
      }
    case "codex-save":
      let readiness = readinessRemovingActions(s.readiness, ["codex-save"])
      next = snapshotCopy(s, codex: codexSectionSavingActive(s.codex), readiness: readiness)
    case "codex-add":
      if let email = result.data?.email ?? value {
        next = snapshotCopy(s, codex: codexSectionAddingSaved(s.codex, email: email))
      }
    case "codex-remove":
      if let value = value {
        let accounts = s.codex.accounts.filter { $0.email != value }
        next = snapshotCopy(s, codex: CodexSection(active: s.codex.active, plan: s.codex.plan, accounts: accounts))
      }
    case "codex-shim-install":
      let readiness = readinessRemovingActions(s.readiness, ["codex-shim-install"])
      let alerts = alertsRemovingActions(s.alerts, ["install-shim", "codex-shim-install"])
      let shim = ShimState(status: "installed", message: "Session resume support installed.", action: nil)
      next = snapshotCopy(s, readiness: readiness, shim: shim, alerts: alerts)
    default:
      break
    }
    if let next = next {
      ignoreSnapshotsBefore = Date()
      applySnapshot(next, force: true)
    }
  }

  func toolEnvironment(_ cfg: Config) -> [String: String] {
    var env = ProcessInfo.processInfo.environment
    var paths: [String] = []
    for p in [cfg.claudeAcct, cfg.script, cfg.node] {
      let dir = (p as NSString).deletingLastPathComponent
      if !dir.isEmpty && !paths.contains(dir) { paths.append(dir) }
    }
    paths.append(env["PATH"] ?? "/usr/bin:/bin:/usr/sbin:/sbin")
    env["PATH"] = paths.joined(separator: ":")
    env["AI_ACCT_MENUBAR_APP"] = Bundle.main.bundlePath
    return env
  }

  func requestSnapshot(completion: ((Bool) -> Void)? = nil) {
    guard let cfg = config else {
      completion?(false)
      return
    }
    if let completion = completion { refreshCompletions.append(completion) }
    if let proc = refreshProcess, proc.isRunning { return }

    let proc = Process()
    proc.executableURL = URL(fileURLWithPath: cfg.node)
    proc.arguments = [cfg.script, "app-state", "--json"]
    proc.environment = toolEnvironment(cfg)
    let out = Pipe()
    proc.standardOutput = out
    proc.standardError = FileHandle.nullDevice
    proc.terminationHandler = { [weak self] _ in
      let data = out.fileHandleForReading.readDataToEndOfFile()
      let decoded = try? JSONDecoder().decode(Snapshot.self, from: data)
      DispatchQueue.main.async {
        guard let self = self else { return }
        self.refreshProcess = nil
        if let snap = decoded { self.applySnapshot(snap) }
        let ok = decoded != nil
        let completions = self.refreshCompletions
        self.refreshCompletions.removeAll()
        for completion in completions { completion(ok) }
      }
    }
    do {
      try proc.run()
      refreshProcess = proc
    } catch {
      refreshProcess = nil
      let completions = refreshCompletions
      refreshCompletions.removeAll()
      for completion in completions { completion(false) }
    }
  }

  // MARK: status item title — provider logo + % left for the active accounts

  func updateStatusTitle() {
    guard let s = snapshot else { return }
    let claudeLeft = s.claude.accounts.first(where: { $0.active })?.percentLeft
    let codexLeft = s.codex.accounts.first(where: { $0.active })?.percentLeft
    let codexText = s.codex.active == nil ? nil : "OpenAI \(pctText(codexLeft))"
    let attention = s.attention == "ok" ? nil : " · attention \(s.attention)"
    let tooltip = (["Claude \(pctText(claudeLeft))", codexText].compactMap { $0 }.joined(separator: " · ")) + (attention ?? "")
    setStatusImage(claudeLeft: claudeLeft, codexLeft: codexLeft, showCodex: s.codex.active != nil, threshold: s.threshold, tooltip: tooltip)
    maybeOpenFirstRunSetup(s)
  }

  func setStatusImage(claudeLeft: Double?, codexLeft: Double?, showCodex: Bool, threshold: Double, tooltip: String?) {
    let image = statusBarImage(claudeLeft: claudeLeft, codexLeft: codexLeft, showCodex: showCodex, threshold: threshold)
    statusItem.length = image.size.width + 8
    guard let button = statusItem.button else { return }
    button.attributedTitle = NSAttributedString(string: "")
    button.image = image
    button.imagePosition = .imageOnly
    button.toolTip = tooltip
  }

  func maybeOpenFirstRunSetup(_ s: Snapshot) {
    let env = ProcessInfo.processInfo.environment
    if env["AI_ACCT_DISABLE_FIRST_RUN_OPEN"] != nil { return }
    let key = "manageAccountsFirstRunShown"
    guard UserDefaults.standard.object(forKey: key) == nil else { return }
    guard s.readiness?.complete == false else { return }
    UserDefaults.standard.set(true, forKey: key)
    DispatchQueue.main.asyncAfter(deadline: .now() + 0.2) { [weak self] in
      self?.openManageAccounts()
    }
  }

  func updateURL(_ update: UpdateState?) -> URL? {
    guard let update = update else { return nil }
    for raw in [update.downloadUrl, update.releaseUrl] {
      if let raw = raw, let url = URL(string: raw) { return url }
    }
    return nil
  }

  func maybePromptUpdate(_ s: Snapshot) {
    let env = ProcessInfo.processInfo.environment
    if env["AI_ACCT_DISABLE_UPDATE_PROMPT"] != nil { return }
    guard let update = s.update, update.available, let latest = update.latestVersion else { return }
    let key = "updatePromptedVersion"
    if UserDefaults.standard.string(forKey: key) == latest { return }
    UserDefaults.standard.set(latest, forKey: key)
    DispatchQueue.main.asyncAfter(deadline: .now() + 0.4) { [weak self] in
      guard let self = self else { return }
      let current = update.currentVersion ?? "unknown"
      let alert = NSAlert()
      alert.messageText = "AI Acct Autopilot \(latest) is available"
      alert.informativeText = "You are running \(current). Download the latest signed DMG from GitHub Releases."
      alert.alertStyle = .informational
      alert.addButton(withTitle: "Download Update")
      alert.addButton(withTitle: "Later")
      if alert.runModal() == .alertFirstButtonReturn {
        self.openUpdate(update)
      }
    }
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
      if let watcherError = watcherError {
        menu.addItem(label([("▲ \(watcherError)", Palette.red)], size: 12))
      } else {
        menu.addItem(label([("starting watcher — first tick can take a few seconds…", Palette.grey)]))
      }
      menu.addItem(.separator())
      menu.addItem(actionItem("Quit", #selector(quit), key: "q"))
      return
    }

    if let watcherError = watcherError {
      menu.addItem(label([("▲ \(watcherError)", Palette.red)], size: 12))
      menu.addItem(.separator())
    }
    for alert in s.alerts {
      let color = alert.level == "red" ? Palette.red : Palette.amber
      menu.addItem(label([("▲ \(alert.text)", color)]))
      if alert.action == "install-shim" {
        menu.addItem(actionItem("    Install the codex shim now", #selector(installShim)))
      } else if alert.action == "update" {
        menu.addItem(actionItem("    Download update", #selector(openUpdateFromMenu)))
      }
    }
    if !s.alerts.isEmpty { menu.addItem(.separator()) }

    // ---- CLAUDE ----
    menu.addItem(header("CLAUDE", provider: .claude))
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
      addUsageRows(acct.rows, trend: acct.trend, threshold: s.threshold, emptyMessage: acct.usageMessage)
      if !acct.active && !acct.recovery {
        let item = actionItem("      switch to \(acct.name)", #selector(switchClaude(_:)))
        item.representedObject = acct.name
        menu.addItem(item)
      }
    }

    // ---- CODEX ----
    menu.addItem(.separator())
    menu.addItem(header("OPENAI · CODEX", provider: .openAI))
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
      addUsageRows(acct.rows, trend: acct.trend, threshold: s.threshold, emptyMessage: nil)
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
    menu.addItem(actionItem("Manage Accounts…", #selector(openManageAccounts), key: ","))
    menu.addItem(actionItem("Refresh now", #selector(refreshNow), key: "r"))
    if snapshot?.update?.available == true {
      menu.addItem(actionItem("Download Update…", #selector(openUpdateFromMenu)))
    }
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

  func addUsageRows(_ rows: [UsageRow], trend: String?, threshold: Double, emptyMessage: String?) {
    if rows.isEmpty {
      menu.addItem(label([("      \(emptyMessage ?? "usage unknown")", Palette.grey)], size: 12))
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

  func header(_ text: String, provider: ProviderLogo? = nil) -> NSMenuItem {
    let item = NSMenuItem()
    if let provider = provider {
      let view = NSView(frame: NSRect(x: 0, y: 0, width: MENU_W, height: 22))
      let icon = NSImageView(frame: NSRect(x: 14, y: 4, width: 13, height: 13))
      icon.image = providerLogoImage(provider, size: 13, color: provider == .openAI ? Palette.grey : nil)
      icon.imageScaling = .scaleProportionallyUpOrDown
      view.addSubview(icon)
      let title = field(text, size: 11, weight: .semibold, color: Palette.grey)
      title.frame = NSRect(x: 34, y: 3, width: MENU_W - 48, height: 16)
      view.addSubview(title)
      item.view = view
      item.isEnabled = false
      return item
    }
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

  func runAppAction(_ action: String, value: String? = nil, completion: ((AppActionResult?) -> Void)? = nil) {
    guard let cfg = config else {
      completion?(nil)
      return
    }
    if let proc = actionProcess, proc.isRunning {
      completion?(AppActionResult(ok: false, action: action, provider: nil,
        message: "Another account action is still running.", changed: false,
        needsRefresh: false, userActionRequired: false,
        errorCode: "action-in-progress", stderrTail: nil, data: nil))
      return
    }
    let proc = Process()
    proc.executableURL = URL(fileURLWithPath: cfg.node)
    var args = [cfg.script, "app-action", action]
    if let value = value, !value.isEmpty { args.append(value) }
    args.append("--json")
    proc.arguments = args
    proc.environment = toolEnvironment(cfg)
    let out = Pipe()
    let err = Pipe()
    proc.standardOutput = out
    proc.standardError = err
    proc.terminationHandler = { [weak self] _ in
      let data = out.fileHandleForReading.readDataToEndOfFile()
      let errData = err.fileHandleForReading.readDataToEndOfFile()
      let decoded = try? JSONDecoder().decode(AppActionResult.self, from: data)
      let errText = String(data: errData, encoding: .utf8)?
        .trimmingCharacters(in: .whitespacesAndNewlines)
      let fallback = AppActionResult(ok: false, action: action, provider: nil,
        message: errText?.isEmpty == false ? errText! : "Action failed.",
        changed: false, needsRefresh: false, userActionRequired: true,
        errorCode: "action-failed", stderrTail: errText, data: nil)
      let result = decoded ?? fallback
      DispatchQueue.main.async {
        if self?.actionProcess === proc { self?.actionProcess = nil }
        completion?(result)
        if result.ok && result.needsRefresh { self?.refreshNowFromWatcherAndState() }
      }
    }
    do {
      try proc.run()
      actionProcess = proc
    } catch {
      DispatchQueue.main.async {
        completion?(AppActionResult(ok: false, action: action, provider: nil,
          message: error.localizedDescription, changed: false,
          needsRefresh: false, userActionRequired: true,
          errorCode: "launch-failed", stderrTail: error.localizedDescription, data: nil))
      }
    }
  }

  @objc func openManageAccounts() {
    if manageAccountsWindow == nil {
      manageAccountsWindow = ManageAccountsWindowController(app: self)
    }
    manageAccountsWindow?.showWindow(nil)
    if let snap = snapshot { manageAccountsWindow?.update(snapshot: snap) }
    NSApp.activate(ignoringOtherApps: true)
  }

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
    guard let name = sender.representedObject as? String else { return }
    runMenuAction("claude-use", value: name)
  }
  @objc func switchCodex(_ sender: NSMenuItem) {
    guard let email = sender.representedObject as? String else { return }
    runMenuAction("codex-use", value: email)
  }
  @objc func installShim() {
    runMenuAction("codex-shim-install")
  }
  func runMenuAction(_ action: String, value: String? = nil) {
    runAppAction(action, value: value) { [weak self] result in
      guard let self = self, let result = result else { return }
      self.optimisticallyApplyAction(action, value: value, result: result)
      if !result.ok || result.userActionRequired { self.showActionResult(result) }
    }
  }
  func showActionResult(_ result: AppActionResult) {
    let alert = NSAlert()
    alert.messageText = "AI Acct Autopilot"
    alert.informativeText = result.message
    alert.alertStyle = result.ok ? .informational : .warning
    alert.addButton(withTitle: "OK")
    NSApp.activate(ignoringOtherApps: true)
    alert.runModal()
  }
  func openUpdate(_ update: UpdateState) {
    if let url = updateURL(update) {
      NSWorkspace.shared.open(url)
    }
  }
  @objc func openUpdateFromMenu() {
    guard let update = snapshot?.update else { return }
    openUpdate(update)
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
    refreshNowFromWatcherAndState()
  }

  func refreshNowFromWatcherAndState(completion: ((Bool) -> Void)? = nil) {
    // SIGUSR2: SIGUSR1 would start node's inspector
    if let proc = child, proc.isRunning {
      kill(proc.processIdentifier, SIGUSR2)
    } else {
      spawnChild()
    }
    requestSnapshot(completion: completion)
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

final class ActionButton: NSButton {
  let actionName: String
  let actionValue: String?

  init(_ title: String, actionName: String, value: String? = nil, target: AnyObject?, selector: Selector) {
    self.actionName = actionName
    self.actionValue = value
    super.init(frame: .zero)
    self.title = title
    self.target = target
    self.action = selector
    self.bezelStyle = .rounded
    self.controlSize = .small
    self.font = NSFont.systemFont(ofSize: 12, weight: .medium)
    if actionName.hasSuffix("-remove") {
      self.contentTintColor = Palette.red
      self.toolTip = "Remove the saved snapshot for \(value ?? "this account")"
    }
  }

  required init?(coder: NSCoder) { fatalError() }
}

final class FlippedDocumentView: NSView {
  override var isFlipped: Bool { true }
}

final class ManageAccountsWindowController: NSWindowController {
  weak var app: AppDelegate?
  let stack = NSStackView()
  let status = NSTextField(labelWithString: "")
  let contentMinWidth: CGFloat = 600
  var latest: Snapshot?

  init(app: AppDelegate) {
    self.app = app
    let window = NSWindow(
      contentRect: NSRect(x: 0, y: 0, width: 660, height: 680),
      styleMask: [.titled, .closable, .miniaturizable, .resizable],
      backing: .buffered,
      defer: false)
    window.title = "Manage Accounts"
    window.minSize = NSSize(width: 640, height: 500)
    super.init(window: window)
    setup()
  }

  required init?(coder: NSCoder) { fatalError() }

  func setup() {
    guard let content = window?.contentView else { return }
    window?.titlebarAppearsTransparent = true
    window?.isMovableByWindowBackground = true
    window?.backgroundColor = .clear
    installTitlebarGlass()

    let glass = NSVisualEffectView()
    glass.translatesAutoresizingMaskIntoConstraints = false
    glass.material = .hudWindow
    glass.blendingMode = .behindWindow
    glass.state = .active

    let scroll = NSScrollView()
    scroll.translatesAutoresizingMaskIntoConstraints = false
    scroll.hasVerticalScroller = true
    scroll.drawsBackground = false
    scroll.contentView.drawsBackground = false
    scroll.automaticallyAdjustsContentInsets = false
    scroll.contentInsets = NSEdgeInsets(top: 0, left: 0, bottom: 0, right: 0)

    stack.orientation = .vertical
    stack.alignment = .leading
    stack.spacing = 12
    stack.detachesHiddenViews = true
    stack.edgeInsets = NSEdgeInsets(top: 18, left: 20, bottom: 18, right: 20)
    stack.translatesAutoresizingMaskIntoConstraints = false

    let host = FlippedDocumentView()
    host.translatesAutoresizingMaskIntoConstraints = false
    host.wantsLayer = true
    host.layer?.backgroundColor = NSColor.clear.cgColor
    host.addSubview(stack)
    scroll.documentView = host
    content.addSubview(glass)
    content.addSubview(scroll)

    NSLayoutConstraint.activate([
      glass.leadingAnchor.constraint(equalTo: content.leadingAnchor),
      glass.trailingAnchor.constraint(equalTo: content.trailingAnchor),
      glass.topAnchor.constraint(equalTo: content.topAnchor),
      glass.bottomAnchor.constraint(equalTo: content.bottomAnchor),
      scroll.leadingAnchor.constraint(equalTo: content.leadingAnchor),
      scroll.trailingAnchor.constraint(equalTo: content.trailingAnchor),
      scroll.topAnchor.constraint(equalTo: content.topAnchor),
      scroll.bottomAnchor.constraint(equalTo: content.bottomAnchor),
      host.widthAnchor.constraint(equalTo: scroll.contentView.widthAnchor),
      stack.leadingAnchor.constraint(equalTo: host.leadingAnchor),
      stack.trailingAnchor.constraint(equalTo: host.trailingAnchor),
      stack.topAnchor.constraint(equalTo: host.topAnchor),
      stack.bottomAnchor.constraint(equalTo: host.bottomAnchor),
    ])

    status.font = NSFont.systemFont(ofSize: 12)
    status.textColor = Palette.grey
    status.lineBreakMode = .byTruncatingTail
    setStatus("")
    rebuild(nil)
  }

  func installTitlebarGlass() {
    guard let titlebar = window?.standardWindowButton(.closeButton)?.superview else { return }
    let glass = NSVisualEffectView()
    glass.translatesAutoresizingMaskIntoConstraints = false
    glass.material = .titlebar
    glass.blendingMode = .withinWindow
    glass.state = .active
    glass.wantsLayer = true
    glass.layer?.backgroundColor = NSColor.windowBackgroundColor.withAlphaComponent(0.22).cgColor

    let separator = NSBox()
    separator.translatesAutoresizingMaskIntoConstraints = false
    separator.boxType = .separator
    separator.alphaValue = 0.55

    titlebar.addSubview(glass, positioned: .below, relativeTo: nil)
    titlebar.addSubview(separator)

    NSLayoutConstraint.activate([
      glass.leadingAnchor.constraint(equalTo: titlebar.leadingAnchor),
      glass.trailingAnchor.constraint(equalTo: titlebar.trailingAnchor),
      glass.topAnchor.constraint(equalTo: titlebar.topAnchor),
      glass.bottomAnchor.constraint(equalTo: titlebar.bottomAnchor),
      separator.leadingAnchor.constraint(equalTo: titlebar.leadingAnchor),
      separator.trailingAnchor.constraint(equalTo: titlebar.trailingAnchor),
      separator.bottomAnchor.constraint(equalTo: titlebar.bottomAnchor),
    ])
  }

  func setStatus(_ message: String) {
    status.stringValue = message
    status.isHidden = message.isEmpty
  }

  func update(snapshot: Snapshot) {
    let wasRefreshing = status.stringValue == "Refreshing..."
    latest = snapshot
    rebuild(snapshot)
    if wasRefreshing { setStatus("Updated just now.") }
  }

  func rebuild(_ snapshot: Snapshot?) {
    for view in stack.arrangedSubviews {
      stack.removeArrangedSubview(view)
      view.removeFromSuperview()
    }

    stack.addArrangedSubview(titleBlock(snapshot))
    stack.addArrangedSubview(status)

    guard let s = snapshot else {
      stack.addArrangedSubview(caption("Waiting for the first account snapshot..."))
      return
    }

    if s.update?.available == true {
      stack.addArrangedSubview(updateBlock(s))
      stack.addArrangedSubview(separator())
    }
    stack.addArrangedSubview(readinessBlock(s))
    stack.addArrangedSubview(separator())
    stack.addArrangedSubview(claudeBlock(s))
    stack.addArrangedSubview(separator())
    stack.addArrangedSubview(codexBlock(s))
    stack.addArrangedSubview(separator())
    stack.addArrangedSubview(footerBlock())
  }

  func titleBlock(_ snapshot: Snapshot?) -> NSView {
    let box = vstack(spacing: 4)
    box.addArrangedSubview(field("Manage Accounts", size: 20, weight: .semibold, color: Palette.text))
    let mode = snapshot?.mode == "monitor" ? "monitor only" : "autopilot on"
    box.addArrangedSubview(caption("Claude and Codex account setup · \(mode)"))
    return box
  }

  func readinessBlock(_ s: Snapshot) -> NSView {
    let box = vstack(spacing: 8)
    let readiness = s.readiness
    let complete = readiness?.complete ?? (s.attention == "ok")
    let color = complete ? Palette.green : ((readiness?.status == "red" || s.attention == "red") ? Palette.red : Palette.amber)
    box.addArrangedSubview(field(complete ? "Ready" : "Needs attention", size: 14, weight: .semibold, color: color))
    let items = readiness?.items ?? []
    if items.isEmpty {
      box.addArrangedSubview(caption("All saved accounts and session resume checks look ready."))
    } else {
      for item in items {
        let c = item.level == "red" ? Palette.red : Palette.amber
        box.addArrangedSubview(labelLine("▲ \(item.text)", color: c))
      }
    }
    return box
  }

  func updateBlock(_ s: Snapshot) -> NSView {
    let row = NSStackView()
    row.orientation = .horizontal
    row.alignment = .centerY
    row.spacing = 8
    let latest = s.update?.latestVersion ?? "latest"
    let current = s.update?.currentVersion ?? "current"
    let text = field("Update available: \(latest) (running \(current))", size: 13, weight: .semibold, color: Palette.amber)
    row.addArrangedSubview(text)
    let spacer = NSView()
    spacer.setContentHuggingPriority(.defaultLow, for: .horizontal)
    row.addArrangedSubview(spacer)
    row.addArrangedSubview(button("Download Update", selector: #selector(downloadUpdate)))
    return row
  }

  func claudeBlock(_ s: Snapshot) -> NSView {
    let box = vstack(spacing: 8)
    box.addArrangedSubview(sectionHeader("Claude", buttons: [
      button("Save Current", selector: #selector(saveClaude)),
      button("Add Account", selector: #selector(addClaude)),
    ]))
    if !s.claude.ok {
      box.addArrangedSubview(labelLine("Claude usage check failed.", color: Palette.red))
    }
    if s.claude.accounts.isEmpty {
      box.addArrangedSubview(caption("No Claude accounts saved."))
    }
    for acct in s.claude.accounts {
      var actions: [NSButton] = []
      // Claude's app-state list is the saved-account list plus recovery
      // snapshots; active and recovery rows intentionally have no Remove.
      if !acct.active && !acct.recovery {
        actions.append(ActionButton("Switch", actionName: "claude-use", value: acct.name, target: self, selector: #selector(runAction(_:))))
        actions.append(ActionButton("Remove", actionName: "claude-remove", value: acct.name, target: self, selector: #selector(confirmRemove(_:))))
      }
      let row = accountLine(
        title: acct.name,
        detail: accountDetail(left: acct.percentLeft, extra: acct.subscription, usageMessage: acct.usageMessage),
        active: acct.active,
        warning: acct.reauth ? "re-auth needed" : (acct.recovery ? "recovered snapshot" : nil),
        actions: actions)
      box.addArrangedSubview(row)
    }
    return box
  }

  func codexBlock(_ s: Snapshot) -> NSView {
    let box = vstack(spacing: 8)
    var headerButtons = [
      button("Save Current", selector: #selector(saveCodex)),
      button("Add Account", selector: #selector(addCodex)),
    ]
    if let action = s.shim?.action {
      let title = s.shim?.status == "outdated" ? "Update Resume" : (action == "codex-shim-install" ? "Install Resume" : "Fix Resume")
      headerButtons.append(ActionButton(title, actionName: action, target: self, selector: #selector(runAction(_:))))
    }
    box.addArrangedSubview(sectionHeader("Codex", buttons: headerButtons))
    if let shim = s.shim {
      let c = shim.status == "installed" ? Palette.green : (shim.action != nil ? Palette.amber : Palette.grey)
      box.addArrangedSubview(labelLine(shim.message, color: c))
    }
    if s.codex.active == nil {
      box.addArrangedSubview(caption("No Codex ChatGPT login found."))
    }
    for acct in s.codex.accounts {
      let warning: String?
      if acct.dead { warning = "re-login needed" }
      else if acct.active && !acct.saved { warning = "not saved" }
      else { warning = nil }
      var action: [NSButton] = []
      if !acct.active && acct.saved {
        if !acct.dead {
          action.append(ActionButton("Switch", actionName: "codex-use", value: acct.email, target: self, selector: #selector(runAction(_:))))
        }
        action.append(ActionButton("Remove", actionName: "codex-remove", value: acct.email, target: self, selector: #selector(confirmRemove(_:))))
      }
      box.addArrangedSubview(accountLine(
        title: acct.email,
        detail: accountDetail(left: acct.percentLeft, extra: acct.active ? s.codex.plan : nil, usageMessage: nil),
        active: acct.active,
        warning: warning,
        actions: action))
    }
    return box
  }

  func footerBlock() -> NSView {
    let row = NSStackView()
    row.orientation = .horizontal
    row.alignment = .centerY
    row.spacing = 8
    row.addArrangedSubview(button("Refresh", selector: #selector(refresh)))
    row.addArrangedSubview(button("Diagnostics", selector: #selector(diagnose)))
    row.addArrangedSubview(button("Terminal Dashboard", selector: #selector(openDashboard)))
    return row
  }

  func sectionHeader(_ title: String, buttons: [NSButton]) -> NSView {
    let row = NSStackView()
    row.orientation = .horizontal
    row.alignment = .centerY
    row.spacing = 8
    row.widthAnchor.constraint(greaterThanOrEqualToConstant: contentMinWidth).isActive = true
    let titleField = field(title, size: 15, weight: .semibold, color: Palette.text)
    row.addArrangedSubview(titleField)
    let spacer = NSView()
    spacer.setContentHuggingPriority(.defaultLow, for: .horizontal)
    row.addArrangedSubview(spacer)
    for b in buttons { row.addArrangedSubview(b) }
    return row
  }

  func accountLine(title: String, detail: String, active: Bool, warning: String?, actions: [NSButton]) -> NSView {
    let row = NSStackView()
    row.orientation = .horizontal
    row.alignment = .centerY
    row.spacing = 8
    row.widthAnchor.constraint(greaterThanOrEqualToConstant: contentMinWidth).isActive = true
    row.addArrangedSubview(field(active ? "●" : "●", size: 10, weight: .regular, color: active ? Palette.green : NSColor.quaternaryLabelColor))
    let text = vstack(spacing: 1)
    text.addArrangedSubview(field(title, size: 13, weight: .semibold, color: active ? Palette.orange : Palette.text))
    var meta = detail
    if let warning = warning { meta += " · \(warning)" }
    text.addArrangedSubview(caption(meta))
    text.setContentHuggingPriority(.defaultLow, for: .horizontal)
    row.addArrangedSubview(text)
    let spacer = NSView()
    spacer.setContentHuggingPriority(.defaultLow, for: .horizontal)
    row.addArrangedSubview(spacer)
    for b in actions { row.addArrangedSubview(b) }
    return row
  }

  func accountDetail(left: Double?, extra: String?, usageMessage: String?) -> String {
    let pct = left == nil ? (usageMessage ?? "usage unknown") : "\(Int(left!.rounded()))% left"
    if let extra = extra, !extra.isEmpty { return "\(pct) · \(extra)" }
    return pct
  }

  func vstack(spacing: CGFloat) -> NSStackView {
    let v = NSStackView()
    v.orientation = .vertical
    v.alignment = .leading
    v.spacing = spacing
    return v
  }

  func separator() -> NSBox {
    let box = NSBox()
    box.boxType = .separator
    box.widthAnchor.constraint(greaterThanOrEqualToConstant: contentMinWidth).isActive = true
    return box
  }

  func caption(_ text: String) -> NSTextField {
    let t = field(text, size: 12, weight: .regular, color: Palette.grey)
    t.lineBreakMode = .byWordWrapping
    t.cell?.wraps = true
    t.cell?.isScrollable = false
    t.maximumNumberOfLines = 2
    t.setContentCompressionResistancePriority(.defaultLow, for: .horizontal)
    t.setContentHuggingPriority(.defaultLow, for: .horizontal)
    return t
  }

  func labelLine(_ text: String, color: NSColor) -> NSTextField {
    let t = field(text, size: 12, weight: .medium, color: color)
    t.lineBreakMode = .byWordWrapping
    t.cell?.wraps = true
    t.cell?.isScrollable = false
    t.maximumNumberOfLines = 3
    t.setContentCompressionResistancePriority(.defaultLow, for: .horizontal)
    t.setContentHuggingPriority(.defaultLow, for: .horizontal)
    return t
  }

  func button(_ title: String, selector: Selector) -> NSButton {
    let b = NSButton(title: title, target: self, action: selector)
    b.bezelStyle = .rounded
    b.controlSize = .small
    b.font = NSFont.systemFont(ofSize: 12, weight: .medium)
    return b
  }

  @objc func runAction(_ sender: ActionButton) {
    setStatus("Running \(sender.title)...")
    app?.runAppAction(sender.actionName, value: sender.actionValue) { [weak self] result in
      if let result = result {
        self?.app?.optimisticallyApplyAction(sender.actionName, value: sender.actionValue, result: result)
      }
      self?.setStatus(result?.message ?? "Action failed.")
      if result?.ok == false { self?.showMessage(result?.message ?? "Action failed.") }
    }
  }

  @objc func confirmRemove(_ sender: ActionButton) {
    let name = sender.actionValue ?? "this account"
    let provider = sender.actionName.hasPrefix("claude") ? "Claude" : "Codex"
    let alert = NSAlert()
    alert.messageText = "Remove \(provider) Account?"
    alert.informativeText = "This removes only the saved snapshot for \(name). It does not log out, revoke tokens, delete sessions, or remove the currently active account."
    alert.alertStyle = .warning
    alert.addButton(withTitle: "Remove")
    alert.addButton(withTitle: "Cancel")
    guard alert.runModal() == .alertFirstButtonReturn else { return }
    runAction(sender)
  }

  @objc func saveClaude() {
    prompt(title: "Save Claude Account", message: "Account name or email", placeholder: "you@example.com") { [weak self] value in
      self?.runNamedAction("claude-save", value: value)
    }
  }

  @objc func addClaude() {
    prompt(title: "Add Claude Account", message: "Account name or email", placeholder: "other@example.com") { [weak self] value in
      self?.runNamedAction("claude-add", value: value)
    }
  }

  @objc func saveCodex() {
    runNamedAction("codex-save", value: nil)
  }

  @objc func addCodex() {
    prompt(title: "Add Codex Account", message: "Email label (optional)", placeholder: "other@example.com", allowEmpty: true) { [weak self] value in
      self?.runNamedAction("codex-add", value: value.isEmpty ? nil : value)
    }
  }

  func runNamedAction(_ action: String, value: String?) {
    setStatus("Running \(action)...")
    app?.runAppAction(action, value: value) { [weak self] result in
      if let result = result {
        self?.app?.optimisticallyApplyAction(action, value: value, result: result)
      }
      self?.setStatus(result?.message ?? "Action failed.")
      if result?.ok == false { self?.showMessage(result?.message ?? "Action failed.") }
    }
  }

  func prompt(title: String, message: String, placeholder: String, allowEmpty: Bool = false, completion: @escaping (String) -> Void) {
    let alert = NSAlert()
    alert.messageText = title
    alert.informativeText = message
    let input = NSTextField(frame: NSRect(x: 0, y: 0, width: 260, height: 24))
    input.placeholderString = placeholder
    alert.accessoryView = input
    alert.addButton(withTitle: "Continue")
    alert.addButton(withTitle: "Cancel")
    let response = alert.runModal()
    guard response == .alertFirstButtonReturn else { return }
    let value = input.stringValue.trimmingCharacters(in: .whitespacesAndNewlines)
    if !allowEmpty && value.isEmpty {
      showMessage("Enter an account name or email first.")
      return
    }
    completion(value)
  }

  @objc func refresh() {
    setStatus("Refreshing...")
    app?.refreshNowFromWatcherAndState { [weak self] ok in
      self?.setStatus(ok ? "Updated just now." : "Refresh failed.")
    }
  }

  @objc func openDashboard() {
    app?.openDashboard()
  }

  @objc func downloadUpdate() {
    guard let update = latest?.update else { return }
    app?.openUpdate(update)
  }

  @objc func diagnose() {
    guard let cfg = app?.config else { return }
    let proc = Process()
    proc.executableURL = URL(fileURLWithPath: cfg.node)
    proc.arguments = [cfg.script, "app-diagnose", "--json"]
    proc.environment = app?.toolEnvironment(cfg)
    let out = Pipe()
    proc.standardOutput = out
    proc.standardError = FileHandle.nullDevice
    proc.terminationHandler = { [weak self] _ in
      let text = String(data: out.fileHandleForReading.readDataToEndOfFile(), encoding: .utf8) ?? "No diagnostics returned."
      DispatchQueue.main.async { self?.showMessage(text) }
    }
    try? proc.run()
  }

  func showMessage(_ message: String) {
    let alert = NSAlert()
    alert.messageText = "AI Acct Autopilot"
    alert.informativeText = message
    alert.addButton(withTitle: "OK")
    alert.runModal()
  }
}
