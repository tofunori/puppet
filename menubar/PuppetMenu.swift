// Puppet's menu bar app: a menu bar icon that shows while puppet acts on the Mac. Click it to see a
// live picture of the window puppet is driving; during actions a small floating window shows the
// same picture, like Codex's picture-in-picture. Right-click for the floating window setting, a way
// to end a session's turn (which releases its browser tabs and clears the Computer Use cursor), and
// Quit.
//
// It reads what the wrappers write: puppet.state.json (one entry per running wrapper) and
// puppet-activity.jsonl (the last actions), in ~/.claude/mcp and in installed puppet plugins.
// The picture needs the Screen Recording permission; images stay in memory, nothing is saved.
// Build with menubar/build.sh.

import AppKit
import ScreenCaptureKit
import SwiftUI

// English, or French when French is the user's first language.
private let prefersFrench = Locale.preferredLanguages.first?.hasPrefix("fr") == true
func tr(_ english: String, _ french: String) -> String { prefersFrench ? french : english }


// ---------- what the wrappers write ----------

struct SessionEntry: Decodable, Identifiable {
    let pid: Int32
    let session_id: String
    let cwd: String?
    let client: String?
    let busy: Bool?
    let turnActive: Bool?
    let action: String?
    let app: String?
    let since: String?
    let snapshot: String?
    let snapshotAt: String?
    let stopped: Bool?
    let tab: String? // the browser tab a browser call last worked in
    var id: Int32 { pid }

    var name: String {
        guard let cwd, cwd != "/" else { return "Claude Desktop" }
        return URL(fileURLWithPath: cwd).lastPathComponent
    }
}

struct StateFile: Decodable { let entries: [SessionEntry] }

struct ActivityLine: Decodable, Identifiable {
    let t: String
    let pid: Int32
    let session: String
    let title: String
    let app: String?
    let ms: Int
    let ok: Bool
    var id: String { t + session }
}

private let isoFormatter: ISO8601DateFormatter = {
    let f = ISO8601DateFormatter()
    f.formatOptions = [.withInternetDateTime, .withFractionalSeconds]
    return f
}()

private let clockFormatter: DateFormatter = {
    let f = DateFormatter()
    f.dateFormat = "HH:mm:ss"
    return f
}()

func isAlive(_ pid: Int32) -> Bool { kill(pid, 0) == 0 || errno == EPERM }

// Folders that may hold a wrapper's files: the script install, and any installed puppet plugin.
func stateDirectories() -> [URL] {
    let home = FileManager.default.homeDirectoryForCurrentUser
    var dirs = [home.appendingPathComponent(".claude/mcp")]
    let cache = home.appendingPathComponent(".claude/plugins/cache")
    if let walker = FileManager.default.enumerator(at: cache, includingPropertiesForKeys: nil, options: [.skipsHiddenFiles]) {
        for case let url as URL in walker where url.lastPathComponent == "puppet-server.mjs" {
            dirs.append(url.deletingLastPathComponent())
        }
    }
    return dirs
}

// ---------- live picture of the driven window ----------

// The wrapper names the target as the code did: an app name ("TextEdit"), a bundle id, or
// "browser" for the browser extension's browser.
private let browserBundles = ["com.vivaldi.Vivaldi", "com.google.Chrome", "com.microsoft.edgemac", "com.brave.Browser"]

func windowMatches(_ window: SCWindow, target: String) -> Bool {
    guard let app = window.owningApplication else { return false }
    if target == "browser" { return browserBundles.contains(app.bundleIdentifier) }
    return app.applicationName.caseInsensitiveCompare(target) == .orderedSame
        || app.bundleIdentifier.caseInsensitiveCompare(target) == .orderedSame
}

// Problems with the live picture go to ~/Library/Logs/puppet-menu.log.
func logLine(_ text: String) {
    let url = FileManager.default.homeDirectoryForCurrentUser.appendingPathComponent("Library/Logs/puppet-menu.log")
    let line = "\(ISO8601DateFormatter().string(from: Date())) \(text)\n"
    if let handle = try? FileHandle(forWritingTo: url) {
        handle.seekToEndOfFile()
        handle.write(Data(line.utf8))
        try? handle.close()
    } else {
        try? line.write(to: url, atomically: true, encoding: .utf8)
    }
}

enum Capture {
    case image(NSImage)
    case noWindow
    case notAllowed
}

// The target app's frontmost normal window, the one Computer Use works in (its focused window), at
// most 900 px wide. The app's largest window showed an old document while puppet typed in a new one. ScreenCaptureKit itself is the test of
// the Screen Recording permission: CGPreflightScreenCaptureAccess() can report false for an app that
// System Settings lists as allowed.
func captureWindow(of target: String) async -> Capture {
    let content: SCShareableContent
    do {
        content = try await SCShareableContent.excludingDesktopWindows(true, onScreenWindowsOnly: true)
    } catch {
        logLine("SCShareableContent failed: \(error)")
        return .notAllowed
    }
    let windows = content.windows.filter { $0.windowLayer == 0 && $0.frame.width > 200 && $0.frame.height > 120 && windowMatches($0, target: target) }
    guard let window = frontmost(windows) else { return .noWindow }
    // The Computer Use cursor is a separate overlay window of the service. Capture the display area of
    // the target window with both the window and those overlays in it, so the cursor shows moving.
    let overlays = content.windows.filter { $0.owningApplication?.bundleIdentifier == "com.openai.sky.CUAService" }
    let display = content.displays.first { $0.frame.intersects(window.frame) } ?? content.displays.first
    let config = SCStreamConfiguration()
    let scale = min(1.0, 900 / window.frame.width) * 2
    config.width = Int(window.frame.width * scale)
    config.height = Int(window.frame.height * scale)
    config.showsCursor = false
    let filter: SCContentFilter
    if let display {
        filter = SCContentFilter(display: display, including: [window] + overlays)
        config.sourceRect = CGRect(x: window.frame.minX - display.frame.minX, y: window.frame.minY - display.frame.minY,
                                   width: window.frame.width, height: window.frame.height)
    } else {
        filter = SCContentFilter(desktopIndependentWindow: window)
    }
    do {
        let image = try await SCScreenshotManager.captureImage(contentFilter: filter, configuration: config)
        return .image(NSImage(cgImage: image, size: NSSize(width: image.width / 2, height: image.height / 2)))
    } catch {
        logLine("captureImage failed: \(error)")
        return .notAllowed
    }
}

// The window system lists on-screen windows front to back; ScreenCaptureKit's list has no order.
func frontmost(_ windows: [SCWindow]) -> SCWindow? {
    let ids = (CGWindowListCopyWindowInfo([.optionOnScreenOnly], kCGNullWindowID) as? [[String: Any]] ?? [])
        .compactMap { $0[kCGWindowNumber as String] as? CGWindowID }
    let rank = Dictionary(ids.enumerated().map { ($1, $0) }, uniquingKeysWith: { a, _ in a })
    return windows.min { (rank[$0.windowID] ?? .max) < (rank[$1.windowID] ?? .max) }
}

// The Computer Use service keeps a JPEG of the window it worked on ("TextEdit Screenshot <date>.jpeg")
// in its temporary folder, which this user can read. Not every action leaves one, but it needs no
// Screen Recording permission.
func latestServiceScreenshot(of target: String) -> NSImage? {
    let dir = URL(fileURLWithPath: NSTemporaryDirectory()).appendingPathComponent("com.openai.sky.CUAService")
    guard let files = try? FileManager.default.contentsOfDirectory(at: dir, includingPropertiesForKeys: [.contentModificationDateKey]) else { return nil }
    let wanted = target == "browser" ? nil : target.lowercased()
    let jpegs = files.filter { $0.pathExtension == "jpeg" && (wanted == nil || $0.lastPathComponent.lowercased().hasPrefix(wanted!)) }
    let newest = jpegs.max { a, b in
        let da = (try? a.resourceValues(forKeys: [.contentModificationDateKey]).contentModificationDate) ?? .distantPast
        let db = (try? b.resourceValues(forKeys: [.contentModificationDateKey]).contentModificationDate) ?? .distantPast
        return da < db
    }
    return newest.flatMap { NSImage(contentsOf: $0) }
}

// ---------- model ----------

final class Model: ObservableObject {
    @Published var sessions: [SessionEntry] = []
    @Published var recent: [ActivityLine] = []
    @Published var preview: NSImage?
    @Published var previewTarget: String?
    @Published var canRecordScreen = true
    private var lastLiveAttempt = Date.distantPast
    @Published var floatingEnabled = UserDefaults.standard.object(forKey: "floatingEnabled") as? Bool ?? true {
        didSet { UserDefaults.standard.set(floatingEnabled, forKey: "floatingEnabled") }
    }
    // The floating window's picture width, set by resizing the window; remembered.
    @Published var floatingWidth: CGFloat = {
        let saved = UserDefaults.standard.double(forKey: "floatingWidth")
        return saved > 0 ? saved : 300
    }() {
        didSet { UserDefaults.standard.set(Double(floatingWidth), forKey: "floatingWidth") }
    }
    // Keep the floating window on screen even when no session is in a turn.
    @Published var floatingPinned = UserDefaults.standard.bool(forKey: "floatingPinned") {
        didSet { UserDefaults.standard.set(floatingPinned, forKey: "floatingPinned") }
    }
    // The mouse is over the floating window: its stop button and the "open the app" arrow show.
    @Published var floatingHover = false
    // The floating window is pressed: it sinks a little until the click ends.
    @Published var floatingPressed = false
    private var dirs: [URL] = stateDirectories()
    private var snapshotFiles: [(url: URL, at: String, app: String?)] = []
    private var lastDirScan = Date()
    private var lastStamp = ""
    private var lastFullRead = Date.distantPast
    private var capturing = false

    var busy: Bool { sessions.contains { $0.busy == true } }
    var turnActive: Bool { sessions.contains { $0.turnActive == true } }
    var busySession: SessionEntry? { sessions.first { $0.busy == true } }

    // What to show: the app of the session acting now, else the one of the last action.
    // The session acting now decides; only with no session acting or in a turn does the last action's
    // app stand in (an unrelated app from an earlier test showed up during a browser task otherwise).
    var target: String? {
        if let busy = busySession { return busy.app }
        if let turn = sessions.first(where: { $0.turnActive == true }) { return turn.app }
        return recent.first?.app
    }

    func refresh() {
        if Date().timeIntervalSince(lastDirScan) > 30 {
            dirs = stateDirectories()
            lastDirScan = Date()
        }
        // Nothing to do when no wrapper file changed since the last read.
        var stamp = ""
        for dir in dirs {
            for name in ["puppet.state.json", "puppet-activity.jsonl"] {
                let attrs = try? FileManager.default.attributesOfItem(atPath: dir.appendingPathComponent(name).path)
                stamp += "\((attrs?[.modificationDate] as? Date)?.timeIntervalSince1970 ?? 0)/\(attrs?[.size] ?? 0);"
            }
        }
        // Sessions can also die without writing anything: recheck them every few seconds anyway.
        if stamp == lastStamp && Date().timeIntervalSince(lastFullRead) < 5 { return }
        lastStamp = stamp
        lastFullRead = Date()
        var live: [SessionEntry] = []
        var lines: [ActivityLine] = []
        var snapshots: [(url: URL, at: String, app: String?)] = []
        let decoder = JSONDecoder()
        for dir in dirs {
            if let data = try? Data(contentsOf: dir.appendingPathComponent("puppet.state.json")),
               let state = try? decoder.decode(StateFile.self, from: data) {
                let alive = state.entries.filter { isAlive($0.pid) }
                live += alive
                for entry in alive {
                    if let name = entry.snapshot, let at = entry.snapshotAt {
                        snapshots.append((dir.appendingPathComponent(name), at, entry.app))
                    }
                }
            }
            if let text = try? String(contentsOf: dir.appendingPathComponent("puppet-activity.jsonl"), encoding: .utf8) {
                for raw in text.split(separator: "\n").suffix(40) {
                    if let line = try? decoder.decode(ActivityLine.self, from: Data(raw.utf8)) { lines.append(line) }
                }
            }
        }
        sessions = live.sorted { ($0.busy == true ? 0 : $0.turnActive == true ? 1 : 2, $0.name) < ($1.busy == true ? 0 : $1.turnActive == true ? 1 : 2, $1.name) }
        recent = Array(lines.sorted { $0.t > $1.t }.prefix(40))
        snapshotFiles = snapshots.sorted { $0.at > $1.at }
    }

    // Tries the live picture first. When it is not allowed, shows the service's last screenshot and
    // tries the live picture again every 30 s, so a permission granted later is picked up.
    func refreshPreview() {
        guard let target else { return }
        // Tabs the agent opens usually stay in the background, so a picture of the browser window
        // would show the user's own tab. For the browser, show the tab snapshots taken after each action.
        if target == "browser" {
            showServiceScreenshot(of: target)
            return
        }
        if !canRecordScreen && Date().timeIntervalSince(lastLiveAttempt) < 30 {
            showServiceScreenshot(of: target)
            return
        }
        guard !capturing else { return }
        capturing = true
        lastLiveAttempt = Date()
        Task {
            let result = await captureWindow(of: target)
            await MainActor.run {
                self.noteSource(result)
                switch result {
                case .image(let image):
                    self.canRecordScreen = true
                    self.preview = image
                    self.previewTarget = target
                case .noWindow:
                    self.canRecordScreen = true
                case .notAllowed:
                    self.canRecordScreen = false
                    self.showServiceScreenshot(of: target)
                }
                self.capturing = false
            }
        }
    }

    // Logs where the picture comes from each time that changes, to tell a refused permission from a
    // window that is not found.
    private var lastSource = ""
    private func noteSource(_ result: Capture) {
        let source: String
        switch result {
        case .image: source = "live picture"
        case .noWindow: source = "live picture allowed, but no window of \(target ?? "?") on screen"
        case .notAllowed: source = "live picture refused; showing snapshots"
        }
        if source != lastSource {
            logLine(source)
            lastSource = source
        }
    }

    // Without the live picture: the wrappers' latest snapshot (taken after each action), else the
    // service's own last screenshot of that app.
    private var shownSnapshot = ""
    private func showServiceScreenshot(of target: String) {
        if let newest = snapshotFiles.first {
            let key = newest.url.path + newest.at
            if key != shownSnapshot, let image = NSImage(contentsOf: newest.url) {
                preview = image
                previewTarget = newest.app ?? target
                shownSnapshot = key
            }
            return
        }
        if let image = latestServiceScreenshot(of: target) {
            preview = image
            previewTarget = target
        }
    }

    // The wrapper ends its turn on SIGUSR2, as when Claude finishes answering (Stop hook).
    func endTurn(_ entry: SessionEntry) { kill(entry.pid, SIGUSR2) }

    // The browser tab of the session the floating window shows.
    var targetTab: String? {
        if let busy = busySession { return busy.tab }
        if let turn = sessions.first(where: { $0.turnActive == true }) { return turn.tab }
        return sessions.first { $0.session_id == recent.first?.session }?.tab
    }

    // The stop button: SIGUSR1 makes the wrappers in a turn refuse further calls until Claude has
    // answered, so Claude stops instead of only losing its turn.
    var stopped: Bool { sessions.contains { $0.stopped == true } }
    var canStop: Bool { !stopped && (busy || turnActive) }
    func stop() {
        for entry in sessions where entry.busy == true || entry.turnActive == true { kill(entry.pid, SIGUSR1) }
    }

    // ---------- the line under the picture ----------

    enum Phase { case acting, waiting, stopped, done }

    var phase: Phase {
        if stopped && !busy { return .stopped }
        if busy { return .acting }
        return turnActive ? .waiting : .done
    }

    // The session the line is about: the one acting, else the one in a turn, else the last one seen.
    private var shownSession: String? {
        busySession?.session_id ?? sessions.first { $0.turnActive == true }?.session_id ?? recent.first?.session
    }

    // "TextEdit", from an app name, a bundle id or a path to the app.
    var appLabel: String {
        guard let target else { return "Puppet" }
        if target == "browser" { return tr("Browser", "Navigateur") }
        if target.hasPrefix("/") { return URL(fileURLWithPath: target).deletingPathExtension().lastPathComponent }
        if target.contains("."), !target.contains(" "), let last = target.split(separator: ".").last { return String(last) }
        return target
    }

    var actionLabel: String {
        switch phase {
        case .acting: return busySession?.action ?? ""
        case .waiting: return recent.first { $0.session == shownSession }?.title ?? ""
        case .stopped: return tr("Stopped", "Arrêté")
        case .done: return tr("Done", "Terminé")
        }
    }

    // The actions of the shown session in its latest run: back from the newest while each came
    // less than a minute after the one before.
    var actionCount: Int {
        let lines = recent.filter { $0.session == shownSession }.compactMap { isoFormatter.date(from: $0.t) }
        var count = 0
        var newer: Date?
        for t in lines {
            if let newer, newer.timeIntervalSince(t) > 60 { break }
            count += 1
            newer = t
        }
        return count + (busy ? 1 : 0)
    }

    func sessionName(for line: ActivityLine) -> String {
        sessions.first { $0.session_id == line.session }?.name ?? ""
    }
}

// ---------- views ----------

// The picture gets an explicit size (the given width, the window's proportions, at most maxHeight):
// with only maximum sizes, a window sized to fit its content collapsed it to nothing. Kept quiet on
// purpose: rounded corners and a hairline edge; the line under it says what puppet does.
struct PreviewView: View {
    @ObservedObject var model: Model
    var width: CGFloat
    var maxHeight: CGFloat
    var radius: CGFloat

    var body: some View {
        if !model.canRecordScreen && model.preview == nil {
            VStack(spacing: 6) {
                Image(systemName: "rectangle.dashed").font(.system(size: 16, weight: .light)).foregroundStyle(.tertiary)
                Text(tr("Allow Puppet in Screen Recording, then open it again.", "Autorise Puppet dans Enregistrement de l'écran, puis rouvre l'app."))
                    .font(.caption).foregroundStyle(.secondary).multilineTextAlignment(.center)
                    .fixedSize(horizontal: false, vertical: true)
                Button(tr("Open Settings", "Ouvrir les réglages")) {
                    CGRequestScreenCaptureAccess()
                    NSWorkspace.shared.open(URL(string: "x-apple.systempreferences:com.apple.preference.security?Privacy_ScreenCapture")!)
                }
                .buttonStyle(.link).font(.caption)
            }
            .padding(.horizontal, 24)
            .frame(width: width, height: min(maxHeight, 110))
        } else if let image = model.preview, image.size.width > 0 {
            let height = min(maxHeight, width * image.size.height / image.size.width)
            Image(nsImage: image)
                .resizable()
                .interpolation(.high)
                .aspectRatio(contentMode: .fit)
                .frame(width: width, height: height)
                .clipShape(RoundedRectangle(cornerRadius: radius, style: .continuous))
                .overlay(RoundedRectangle(cornerRadius: radius, style: .continuous).strokeBorder(Color.white.opacity(0.08), lineWidth: 1))
        } else {
            Image(systemName: "rectangle.dashed")
                .font(.system(size: 22, weight: .light)).foregroundStyle(.tertiary)
                .frame(width: width, height: min(maxHeight, 90))
        }
    }
}

// One quiet line: a mark for the phase (blue dot while acting), the app, the action, the count.
// With openHint, a small arrow after the app says a click on the window goes there.
struct CaptionView: View {
    @ObservedObject var model: Model
    var openHint = false

    var body: some View {
        HStack(spacing: 7) {
            switch model.phase {
            case .acting:
                Circle().fill(Color.blue).frame(width: 7, height: 7).shadow(color: .blue.opacity(0.6), radius: 3)
            case .waiting:
                Circle().fill(Color.secondary.opacity(0.5)).frame(width: 7, height: 7)
            case .stopped:
                RoundedRectangle(cornerRadius: 1.5).fill(Color.secondary).frame(width: 7, height: 7)
            case .done:
                Image(systemName: "checkmark").font(.system(size: 9, weight: .semibold)).foregroundStyle(.secondary)
            }
            Text(model.appLabel).font(.system(size: 12, weight: .semibold)).lineLimit(1).layoutPriority(1)
            Image(systemName: "arrow.up.right").font(.system(size: 8, weight: .semibold)).foregroundStyle(.secondary)
                .padding(.leading, -3).opacity(openHint ? 1 : 0)
            Text(model.actionLabel).font(.system(size: 12)).foregroundStyle(.secondary).lineLimit(1).truncationMode(.tail)
            Spacer(minLength: 6)
            if model.actionCount > 0 {
                Text("\(model.actionCount) action\(model.actionCount > 1 ? "s" : "")")
                    .font(.system(size: 11)).foregroundStyle(.tertiary).lineLimit(1).fixedSize()
            }
        }
        .padding(.horizontal, 6)
        .padding(.top, 7)
        .padding(.bottom, 3)
        .accessibilityElement(children: .combine)
    }
}

// The menu's window: the picture of the window puppet drives and the line under it. Settings and
// "end the turn" are in the icon's right-click menu.
struct ContentView: View {
    @ObservedObject var model: Model

    var body: some View {
        VStack(spacing: 0) {
            PreviewView(model: model, width: 380, maxHeight: 260, radius: 10)
            CaptionView(model: model)
        }
        .frame(width: 380)
        .padding(6)
        .background(.regularMaterial, in: RoundedRectangle(cornerRadius: 14, style: .continuous))
        .overlay(RoundedRectangle(cornerRadius: 14, style: .continuous).strokeBorder(Color.white.opacity(0.08), lineWidth: 1))
        .shadow(color: .black.opacity(0.35), radius: 10, y: 4)
        .padding(12)
    }
}

// The small floating window shown during actions: the same picture, smaller, and a stop button
// that shows only while the mouse is over the window. A click elsewhere on it goes to the app
// puppet drives (DraggableHostingView handles both clicks).
struct FloatingView: View {
    @ObservedObject var model: Model

    var body: some View {
        VStack(spacing: 0) {
            PreviewView(model: model, width: model.floatingWidth, maxHeight: model.floatingWidth * 0.8, radius: 10)
                .brightness(model.floatingHover ? 0.04 : 0)
                .overlay(alignment: .topTrailing) {
                    if model.floatingHover && model.canStop {
                        StopButtonLook().padding(FloatingView.stopInset).transition(.opacity)
                    }
                }
            CaptionView(model: model, openHint: model.floatingHover)
        }
        .frame(width: model.floatingWidth)
        .padding(4)
        .background(.regularMaterial, in: RoundedRectangle(cornerRadius: 14, style: .continuous))
        .overlay(RoundedRectangle(cornerRadius: 14, style: .continuous)
            .strokeBorder(Color.white.opacity(model.floatingHover ? 0.16 : 0.08), lineWidth: 1))
        .shadow(color: .black.opacity(0.35), radius: 10, y: 4)
        .scaleEffect(model.floatingPressed ? 0.985 : 1)
        .padding(12)
        .animation(.easeOut(duration: 0.15), value: model.floatingHover)
        .animation(.easeOut(duration: 0.1), value: model.floatingPressed)
    }

    // Where the stop button sits, from the window's top-right corner: the outer margin, the frame's
    // padding, then the inset inside the picture. DraggableHostingView uses the same numbers.
    static let stopInset: CGFloat = 8
    static let stopSize: CGFloat = 22
    static let stopFromCorner: CGFloat = 12 + 4 + stopInset
}

struct StopButtonLook: View {
    var body: some View {
        ZStack {
            Circle().fill(Color.black.opacity(0.55))
            Circle().strokeBorder(Color.white.opacity(0.14), lineWidth: 1)
            RoundedRectangle(cornerRadius: 1.5).fill(Color.white.opacity(0.85)).frame(width: 7, height: 7)
        }
        .frame(width: FloatingView.stopSize, height: FloatingView.stopSize)
        .help(tr("Stop", "Arrêter"))
        .accessibilityElement()
        .accessibilityLabel(tr("Stop Puppet", "Arrêter Puppet"))
        .accessibilityAddTraits(.isButton)
    }
}

// A hosting view the floating window can be dragged by (borderless windows only move when the view
// under the mouse says so); a click without a drag opens the app puppet drives. A press near the
// left or bottom edge resizes instead: the window keeps its top-right corner, so pulling left or
// down makes it bigger.
final class DraggableHostingView<Content: View>: NSHostingView<Content> {
    var currentWidth: () -> CGFloat = { 300 }
    var setWidth: (CGFloat) -> Void = { _ in }
    // The stop button: whether it shows, and what a click on it does. Puppet never becomes the active
    // app, so hover is tracked here with an always-active tracking area rather than by SwiftUI.
    var stopShown: () -> Bool = { false }
    var onStop: () -> Void = {}
    var onHover: (Bool) -> Void = { _ in }
    var onPress: (Bool) -> Void = { _ in }
    var onOpen: () -> Void = {}
    private let edge: CGFloat = 22

    override var mouseDownCanMoveWindow: Bool { true }
    override func acceptsFirstMouse(for event: NSEvent?) -> Bool { true }

    override func updateTrackingAreas() {
        super.updateTrackingAreas()
        for area in trackingAreas where area.owner === self && area.userInfo?["puppet"] != nil { removeTrackingArea(area) }
        addTrackingArea(NSTrackingArea(rect: .zero, options: [.mouseEnteredAndExited, .mouseMoved, .activeAlways, .inVisibleRect],
                                       owner: self, userInfo: ["puppet": true]))
    }

    override func mouseEntered(with event: NSEvent) {
        onHover(true)
        updateCursor(event)
    }
    override func mouseExited(with event: NSEvent) {
        onHover(false)
        NSCursor.arrow.set()
    }
    override func mouseMoved(with event: NSEvent) { updateCursor(event) }

    // Cursor rects only work in the key window, and this one never is: set the cursor as it moves.
    private func updateCursor(_ event: NSEvent) {
        let p = event.locationInWindow
        if p.x < edge { NSCursor.resizeLeftRight.set() }
        else if p.y < edge { NSCursor.resizeUpDown.set() }
        else { NSCursor.pointingHand.set() }
    }

    // A slightly larger square than the button, so it is easy to hit.
    private var stopZone: NSRect {
        let size = FloatingView.stopSize + 10
        let corner = FloatingView.stopFromCorner - 5
        return NSRect(x: bounds.width - corner - size, y: bounds.height - corner - size, width: size, height: size)
    }

    override func mouseDown(with event: NSEvent) {
        let p = event.locationInWindow
        if stopShown(), stopZone.contains(p) {
            onStop()
            return
        }
        guard p.x < edge || p.y < edge else {
            clickOrDrag()
            return
        }
        let start = NSEvent.mouseLocation
        let startWidth = currentWidth()
        while let next = window?.nextEvent(matching: [.leftMouseDragged, .leftMouseUp]), next.type == .leftMouseDragged {
            let now = NSEvent.mouseLocation
            let grow = max(start.x - now.x, start.y - now.y)
            setWidth(min(1000, max(180, startWidth + grow)))
        }
    }

    // Moves the window with the mouse once it has gone 3 points; a press that never moves is a click.
    private func clickOrDrag() {
        guard let window else { return }
        let start = NSEvent.mouseLocation
        let origin = window.frame.origin
        var moved = false
        onPress(true)
        while let next = window.nextEvent(matching: [.leftMouseDragged, .leftMouseUp]), next.type == .leftMouseDragged {
            let now = NSEvent.mouseLocation
            if !moved && hypot(now.x - start.x, now.y - start.y) < 3 { continue }
            if !moved {
                moved = true
                onPress(false)
            }
            window.setFrameOrigin(NSPoint(x: origin.x + now.x - start.x, y: origin.y + now.y - start.y))
        }
        onPress(false)
        if !moved { onOpen() }
    }

    override func resetCursorRects() {
        addCursorRect(NSRect(x: 0, y: 0, width: edge, height: bounds.height), cursor: .resizeLeftRight)
        addCursorRect(NSRect(x: 0, y: isFlipped ? bounds.height - edge : 0, width: bounds.width, height: edge), cursor: .resizeUpDown)
    }
}

// ---------- menu bar ----------

final class AppDelegate: NSObject, NSApplicationDelegate {
    private let model = Model()
    private var statusItem: NSStatusItem!
    // The menu's window: a borderless panel hung right under the icon (an NSPopover sat too low).
    private var menuPanel: NSPanel?
    private var menuHost: NSHostingView<ContentView>?
    private var outsideClicks: Any?
    private var floating: NSPanel?
    private var floatingHost: DraggableHostingView<FloatingView>?
    private var timer: Timer?
    private var lastActive = Date.distantPast

    func applicationDidFinishLaunching(_ notification: Notification) {
        statusItem = NSStatusBar.system.statusItem(withLength: NSStatusItem.squareLength)
        statusItem.button?.action = #selector(togglePopover)
        statusItem.button?.target = self
        statusItem.button?.sendAction(on: [.leftMouseUp, .rightMouseUp])
        revealUntil = Date().addingTimeInterval(30)
        // Without the Screen Recording permission, ask macOS once: that also lists the app in
        // System Settings, where it can be turned on.
        Task {
            do { _ = try await SCShareableContent.current } catch { CGRequestScreenCaptureAccess() }
        }
        tick()
        timer = Timer.scheduledTimer(withTimeInterval: 0.1, repeats: true) { [weak self] _ in self?.tick() }
        NSWorkspace.shared.notificationCenter.addObserver(forName: NSWorkspace.didActivateApplicationNotification, object: nil, queue: .main) { [weak self] note in
            self?.appActivated(note.userInfo?[NSWorkspace.applicationUserInfoKey] as? NSRunningApplication)
        }
    }

    // The ChatGPT extension brings the browser to the front when puppet opens a tab, which takes the
    // keyboard from the app the user is typing in. A browser that comes forward while a session's
    // browser call runs, without a click from the user, gives the front back. Only during a call, so
    // the user's own Cmd-Tab to the browser between calls stands.
    private var lastUserFront: NSRunningApplication?

    private func appActivated(_ app: NSRunningApplication?) {
        guard let app, app.processIdentifier != getpid() else { return }
        let isBrowser = browserBundles.contains(app.bundleIdentifier ?? "")
        guard isBrowser else {
            lastUserFront = app
            return
        }
        model.refresh()
        let inBrowser = model.sessions.contains { $0.busy == true && ($0.app == "browser" || browserBundles.contains($0.app ?? "")) }
        let openedByUser = Date().timeIntervalSince(openedAt) < 2
        guard inBrowser, !openedByUser, !userJustActed(), let previous = lastUserFront, !previous.isTerminated else {
            if inBrowser {
                let ago = CGEventSource.secondsSinceLastEventType(.hidSystemState, eventType: .leftMouseDown)
                logLine("left \(app.localizedName ?? "the browser") in front: the user clicked \(String(format: "%.2f", ago)) s before")
            }
            lastUserFront = app
            return
        }
        previous.activate(options: [])
        logLine("gave the front back to \(previous.localizedName ?? "?") after \(app.localizedName ?? "the browser") came forward")
    }

    // A click (in the window or the Dock) in the last half second: the user brought that app forward.
    // Keys do not count: the user is often typing in another app, with Shift, when the browser jumps
    // forward. Hardware input only: the Computer Use service's own clicks must not count.
    private func userJustActed() -> Bool {
        let types: [CGEventType] = [.leftMouseDown, .rightMouseDown]
        return types.contains { CGEventSource.secondsSinceLastEventType(.hidSystemState, eventType: $0) < 0.5 }
    }

    // Opening the app again shows the icon for 30 s, to reach its menu while Computer Use rests.
    func applicationShouldHandleReopen(_ sender: NSApplication, hasVisibleWindows flag: Bool) -> Bool {
        revealUntil = Date().addingTimeInterval(30)
        return false
    }

    // Every 0.1 s: the wrappers' files are read every 0.3 s, and the picture is taken every tick while
    // puppet acts (so the cursor's moves show) and every 0.5 s otherwise.
    private var lastRead = Date.distantPast
    private var lastPicture = Date.distantPast

    private func tick() {
        if Date().timeIntervalSince(lastRead) >= 0.3 {
            model.refresh()
            lastRead = Date()
        }
        // A turn lasts until Claude finishes answering (Stop hook) or one idle minute in Claude Desktop.
        if model.busy || model.turnActive { lastActive = Date() }
        updateIcon()
        // The floating window shows for the whole turn and 10 s after it (2 s after the stop button),
        // or always when pinned.
        let linger: TimeInterval = model.phase == .stopped ? 2 : 10
        var showFloating = model.floatingPinned || (model.floatingEnabled && Date().timeIntervalSince(lastActive) < linger)
        // Hidden while the user is in the app they opened from it; back when they leave that app.
        if let pid = hiddenForApp {
            if NSWorkspace.shared.frontmostApplication?.processIdentifier == pid || Date().timeIntervalSince(openedAt) < 1.5 {
                showFloating = false
            } else {
                hiddenForApp = nil
            }
        }
        if showFloating { showFloatingWindow() } else { hideFloatingWindow() }
        let menuShown = menuPanel?.isVisible == true
        if menuShown { placeMenuPanel() }
        if (menuShown || showFloating) && (model.busy || Date().timeIntervalSince(lastPicture) >= 0.5) {
            model.refreshPreview()
            lastPicture = Date()
        }
    }

    // The icon shows only while Computer Use is active and 10 s after, while its menu is open, or for
    // 30 s after the app is opened again (Finder or Spotlight), so its menu stays reachable.
    private var revealUntil = Date.distantPast
    private var iconState = ""
    private func updateIcon() {
        let recent = Date().timeIntervalSince(lastActive) < 10
        let visible = recent || menuPanel?.isVisible == true || Date() < revealUntil
        if statusItem.isVisible != visible { statusItem.isVisible = visible }
        guard visible, let button = statusItem.button else { return }
        // A plain template arrow in the menu bar's own color; rays are added while puppet acts.
        let state = "\(model.busy)/\(model.turnActive)/\(model.busySession?.action ?? "")"
        if state == iconState { return }
        iconState = state
        let image = NSImage(systemSymbolName: model.busy ? "cursorarrow.rays" : "cursorarrow", accessibilityDescription: "Puppet")
        image?.isTemplate = true
        button.image = image
        button.alphaValue = model.busy || model.turnActive ? 1.0 : 0.6
        button.toolTip = model.busy
            ? tr("Puppet is acting: ", "Puppet agit : ") + (model.busySession?.action ?? "")
            : model.turnActive ? tr("Puppet: turn in progress", "Puppet : tour en cours") : tr("Puppet: idle", "Puppet : au repos")
    }

    // A borderless, non-activating panel, by default in the top-right corner under the menu bar, above
    // other windows and on every Space; it never takes focus from the app being driven. Drag it to
    // move it, pull its left or bottom edge to resize it: the picture keeps the window's proportions,
    // so the width sets the size. Position and width are remembered.
    private let floatingMargin: CGFloat = 12 // FloatingView's padding around the picture

    private func showFloatingWindow() {
        if floating == nil {
            let panel = NSPanel(contentRect: NSRect(x: 0, y: 0, width: 340, height: 140),
                                styleMask: [.borderless, .nonactivatingPanel], backing: .buffered, defer: false)
            panel.level = .floating
            panel.isOpaque = false
            panel.backgroundColor = .clear
            panel.hasShadow = false // the picture draws its own soft shadow
            panel.isMovableByWindowBackground = true
            panel.collectionBehavior = [.canJoinAllSpaces, .fullScreenAuxiliary]
            let host = DraggableHostingView(rootView: FloatingView(model: model))
            host.currentWidth = { [weak self] in self?.model.floatingWidth ?? 300 }
            host.setWidth = { [weak self] width in
                self?.model.floatingWidth = width
                self?.showFloatingWindow() // follow at once, not at the next tick
            }
            host.stopShown = { [weak self] in (self?.model.floatingHover ?? false) && (self?.model.canStop ?? false) }
            host.onStop = { [weak self] in self?.model.stop() }
            host.onHover = { [weak self] inside in self?.model.floatingHover = inside }
            host.onPress = { [weak self] down in self?.model.floatingPressed = down }
            host.onOpen = { [weak self] in self?.openDrivenApp() }
            panel.contentView = host
            floatingHost = host
            let size = host.fittingSize
            if !panel.setFrameUsingName("puppet-floating-v2"), let screen = NSScreen.main?.visibleFrame {
                panel.setFrame(NSRect(x: screen.maxX - size.width - 8, y: screen.maxY - size.height - 8,
                                      width: size.width, height: size.height), display: false)
            }
            panel.setFrameAutosaveName("puppet-floating-v2")
            floating = panel
        }
        guard let panel = floating, let host = floatingHost else { return }
        // Follow the content's size, keeping the top-right corner in place.
        let size = host.fittingSize
        if size.width > 0, size.height > 0, panel.frame.size != size {
            let corner = NSPoint(x: panel.frame.maxX, y: panel.frame.maxY)
            panel.setFrame(NSRect(x: corner.x - size.width, y: corner.y - size.height, width: size.width, height: size.height), display: true)
        }
        if !panel.isVisible || fadingOut {
            // Fade in; from a fade out under way, back up from where it is.
            fadingOut = false
            if !panel.isVisible { panel.alphaValue = 0 }
            panel.orderFrontRegardless()
            NSAnimationContext.runAnimationGroup { context in
                context.duration = 0.25
                context.timingFunction = CAMediaTimingFunction(name: .easeOut)
                panel.animator().alphaValue = 1
            }
        }
    }

    private var fadingOut = false

    // ---------- going to the app puppet drives ----------

    private var hiddenForApp: pid_t?
    private var openedAt = Date.distantPast
    private var ghost: NSPanel?

    // The picture grows from the floating window to the real window while that app comes to the
    // front, then fades; the floating window fades out and stays hidden while the user is there.
    private func openDrivenApp() {
        guard let panel = floating, let target = model.target else { return }
        // In the browser, select puppet's tab and raise its window first, so the picture lands there.
        if target == "browser", let tab = model.targetTab { selectTab(tab) }
        let found = drivenWindow(for: target)
        guard let app = found?.app ?? runningApp(for: target) else { return }
        openedAt = Date()
        hiddenForApp = app.processIdentifier
        lastUserFront = app
        model.floatingHover = false
        let start = panel.frame
        hideFloatingWindow()
        app.activate(options: [])
        guard let frame = found?.frame, let image = model.preview else { return }
        let captionHeight: CGFloat = 26
        let ghost = NSPanel(contentRect: NSRect(x: start.minX + 16, y: start.minY + 16 + captionHeight,
                                                width: start.width - 32, height: start.height - 32 - captionHeight),
                            styleMask: [.borderless, .nonactivatingPanel], backing: .buffered, defer: false)
        ghost.level = .floating
        ghost.isOpaque = false
        ghost.backgroundColor = .clear
        ghost.hasShadow = true
        ghost.ignoresMouseEvents = true
        let view = NSImageView()
        view.image = image
        view.imageScaling = .scaleAxesIndependently
        view.wantsLayer = true
        view.layer?.cornerRadius = 10
        view.layer?.masksToBounds = true
        ghost.contentView = view
        ghost.orderFrontRegardless()
        self.ghost = ghost
        NSAnimationContext.runAnimationGroup({ context in
            context.duration = 0.34
            context.timingFunction = CAMediaTimingFunction(controlPoints: 0.2, 0.8, 0.2, 1)
            ghost.animator().setFrame(frame, display: true)
        }, completionHandler: { [weak self] in
            NSAnimationContext.runAnimationGroup({ context in
                context.duration = 0.15
                ghost.animator().alphaValue = 0
            }, completionHandler: {
                ghost.orderOut(nil)
                if self?.ghost === ghost { self?.ghost = nil }
            })
        })
    }

    // The app's frontmost normal window on screen (window list order is front to back), in Cocoa
    // screen coordinates.
    private func drivenWindow(for target: String) -> (app: NSRunningApplication, frame: NSRect)? {
        let list = CGWindowListCopyWindowInfo([.optionOnScreenOnly, .excludeDesktopElements], kCGNullWindowID) as? [[String: Any]] ?? []
        let screenHeight = NSScreen.screens.first?.frame.height ?? 0
        for info in list where (info[kCGWindowLayer as String] as? Int) == 0 {
            guard let pid = info[kCGWindowOwnerPID as String] as? pid_t,
                  let app = NSRunningApplication(processIdentifier: pid), matches(app, target),
                  let bounds = info[kCGWindowBounds as String], let rect = CGRect(dictionaryRepresentation: bounds as! CFDictionary),
                  rect.width > 200, rect.height > 120 else { continue }
            return (app, NSRect(x: rect.minX, y: screenHeight - rect.maxY, width: rect.width, height: rect.height))
        }
        return nil
    }

    // Chromium browsers number their tabs in AppleScript as the extension does: find puppet's tab in
    // a running browser, make it the active tab and its window the browser's front one. The first
    // time, macOS asks the user to let Puppet control the browser.
    private func selectTab(_ tab: String) {
        guard tab.allSatisfy(\.isNumber) else { return }
        for app in NSWorkspace.shared.runningApplications {
            guard let bundle = app.bundleIdentifier, browserBundles.contains(bundle) else { continue }
            let source = """
            tell application id "\(bundle)"
                repeat with w in windows
                    set i to 0
                    repeat with t in tabs of w
                        set i to i + 1
                        if (id of t as text) is "\(tab)" then
                            set active tab index of w to i
                            set index of w to 1
                            return true
                        end if
                    end repeat
                end repeat
                return false
            end tell
            """
            var error: NSDictionary?
            let result = NSAppleScript(source: source)?.executeAndReturnError(&error)
            if let error { logLine("could not select tab \(tab) in \(bundle): \(error)") }
            if result?.booleanValue == true { return }
        }
    }

    // No window on screen (minimized, another Space): the app alone, to bring it forward.
    private func runningApp(for target: String) -> NSRunningApplication? {
        NSWorkspace.shared.runningApplications.first { matches($0, target) }
    }

    private func matches(_ app: NSRunningApplication, _ target: String) -> Bool {
        if target == "browser" { return browserBundles.contains(app.bundleIdentifier ?? "") }
        if target.hasPrefix("/") { return app.bundleURL?.path == target }
        return app.localizedName?.caseInsensitiveCompare(target) == .orderedSame
            || app.bundleIdentifier?.caseInsensitiveCompare(target) == .orderedSame
    }

    private func hideFloatingWindow() {
        guard let panel = floating, panel.isVisible, !fadingOut else { return }
        fadingOut = true
        model.floatingHover = false
        NSAnimationContext.runAnimationGroup({ context in
            context.duration = 0.3
            context.timingFunction = CAMediaTimingFunction(name: .easeIn)
            panel.animator().alphaValue = 0
        }, completionHandler: { [weak self] in
            // Shown again during the fade: leave it.
            guard let self, self.fadingOut else { return }
            self.fadingOut = false
            panel.orderOut(nil)
            panel.alphaValue = 1
        })
    }

    @objc private func togglePopover() {
        if NSApp.currentEvent?.type == .rightMouseUp {
            showMenu()
            return
        }
        if menuPanel?.isVisible == true {
            hideMenuPanel()
        } else {
            model.refresh()
            model.refreshPreview()
            showMenuPanel()
        }
    }

    private func showMenuPanel() {
        if menuPanel == nil {
            let panel = NSPanel(contentRect: NSRect(x: 0, y: 0, width: 420, height: 200),
                                styleMask: [.borderless, .nonactivatingPanel], backing: .buffered, defer: false)
            panel.level = .statusBar
            panel.isOpaque = false
            panel.backgroundColor = .clear
            panel.hasShadow = false
            panel.collectionBehavior = [.canJoinAllSpaces, .fullScreenAuxiliary]
            let host = NSHostingView(rootView: ContentView(model: model))
            panel.contentView = host
            menuHost = host
            menuPanel = panel
        }
        placeMenuPanel()
        menuPanel?.orderFrontRegardless()
        // A click anywhere else closes it, like a menu.
        outsideClicks = NSEvent.addGlobalMonitorForEvents(matching: [.leftMouseDown, .rightMouseDown]) { [weak self] _ in
            self?.hideMenuPanel()
        }
    }

    private func hideMenuPanel() {
        menuPanel?.orderOut(nil)
        if let monitor = outsideClicks { NSEvent.removeMonitor(monitor) }
        outsideClicks = nil
    }

    // Centered under the icon, its top edge just below the menu bar, kept on screen.
    private func placeMenuPanel() {
        guard let panel = menuPanel, let host = menuHost, let iconWindow = statusItem.button?.window else { return }
        let size = host.fittingSize
        guard size.width > 0, size.height > 0 else { return }
        let icon = iconWindow.frame
        let screen = iconWindow.screen?.visibleFrame ?? NSScreen.main?.visibleFrame ?? .zero
        var x = icon.midX - size.width / 2
        x = min(max(x, screen.minX + 4), screen.maxX - size.width - 4)
        let y = icon.minY - size.height + 8 // the view's own 12-point margin sits under the menu bar
        let frame = NSRect(x: x, y: y, width: size.width, height: size.height)
        if panel.frame != frame { panel.setFrame(frame, display: true) }
    }
}

extension AppDelegate {
    // Right click: the floating window setting, one "end the turn" item per session in a turn, Quit.
    func showMenu() {
        let menu = NSMenu()
        let floatingItem = NSMenuItem(title: tr("Floating window during actions", "Fenêtre flottante pendant les actions"), action: #selector(toggleFloating), keyEquivalent: "")
        floatingItem.target = self
        floatingItem.state = model.floatingEnabled ? .on : .off
        menu.addItem(floatingItem)
        let pinItem = NSMenuItem(title: tr("Always show the floating window", "Toujours afficher la fenêtre flottante"), action: #selector(togglePinned), keyEquivalent: "")
        pinItem.target = self
        pinItem.state = model.floatingPinned ? .on : .off
        menu.addItem(pinItem)
        let active = model.sessions.filter { $0.turnActive == true }
        if !active.isEmpty {
            menu.addItem(.separator())
            for entry in active {
                let item = NSMenuItem(title: tr("End the turn: ", "Terminer le tour : ") + entry.name, action: #selector(endTurnItem(_:)), keyEquivalent: "")
                item.target = self
                item.representedObject = entry.pid
                menu.addItem(item)
            }
        }
        menu.addItem(.separator())
        let quit = NSMenuItem(title: tr("Quit Puppet", "Quitter Puppet"), action: #selector(NSApplication.terminate(_:)), keyEquivalent: "q")
        menu.addItem(quit)
        statusItem.menu = menu
        statusItem.button?.performClick(nil)
        statusItem.menu = nil
    }

    @objc func toggleFloating() { model.floatingEnabled.toggle() }

    @objc func togglePinned() { model.floatingPinned.toggle() }

    @objc func endTurnItem(_ sender: NSMenuItem) {
        if let pid = sender.representedObject as? Int32 { kill(pid, SIGUSR2) }
    }
}

@main
struct PuppetMenu {
    static func main() {
        let app = NSApplication.shared
        let delegate = AppDelegate()
        app.delegate = delegate
        app.setActivationPolicy(.accessory)
        app.run()
    }
}
