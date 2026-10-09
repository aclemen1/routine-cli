import AppKit
import Foundation
import ServiceManagement

// routine prints {ok, result} by default.
struct Envelope<T: Decodable>: Decodable {
    let ok: Bool
    let result: T?
}

struct Failure: Decodable {
    struct Detail: Decodable { let message: String }
    let error: Detail
}

struct EngineStatus: Decodable {
    let stopped: Bool
    let routines: Int
    let active: Int
    let running: [String]
    let due: [String]
    let invalid: Int
}

struct LastRun: Decodable {
    let status: String
    let started: String
}

struct RoutineSummary: Decodable, Identifiable {
    let id: String
    let active: Bool
    let running: Bool
    let next: String?
    let lastRun: LastRun?
}

struct RoutineList: Decodable {
    let routines: [RoutineSummary]
}

struct RunRecord: Decodable, Identifiable {
    let id: String
    let started: String
    let status: String
    let manual: Bool?
    var key: String { "\(id)@\(started)" }
}

enum Settings {
    static var defaults: UserDefaults { .standard }
    static var nodePath: String { defaults.string(forKey: "nodePath") ?? "/opt/homebrew/bin/node" }
    static var cliPath: String {
        let path = defaults.string(forKey: "cliPath") ?? "~/code/aclemen1/routine-cli/dist/cli.js"
        return (path as NSString).expandingTildeInPath
    }
    static var logPath: String { ("~/Library/Logs/routine.log" as NSString).expandingTildeInPath }
}

@MainActor
final class Engine: ObservableObject {
    @Published private(set) var status: EngineStatus?
    @Published private(set) var routines: [RoutineSummary] = []
    @Published private(set) var recent: [RunRecord] = []
    @Published private(set) var lastTick: Date?
    @Published private(set) var lastError: String?
    @Published private(set) var launchAtLogin = SMAppService.mainApp.status == .enabled

    private var timer: Timer?
    private var activity: NSObjectProtocol?

    var hasFailure: Bool { recent.last.map { $0.status != "ok" } ?? false }

    func start() {
        guard timer == nil else { return }
        // Without this, App Nap delays the minute timer of a menu-bar app.
        activity = ProcessInfo.processInfo.beginActivity(options: .userInitiatedAllowingIdleSystemSleep, reason: "Routine schedule")
        NSWorkspace.shared.notificationCenter.addObserver(forName: NSWorkspace.didWakeNotification, object: nil, queue: .main) { [weak self] _ in
            Task { @MainActor in self?.tick() }
        }
        tick()
        let now = Date()
        let nextMinute = Calendar.current.nextDate(after: now, matching: DateComponents(second: 1), matchingPolicy: .nextTime) ?? now.addingTimeInterval(60)
        let timer = Timer(fire: nextMinute, interval: 60, repeats: true) { [weak self] _ in
            Task { @MainActor in self?.tick() }
        }
        timer.tolerance = 2
        RunLoop.main.add(timer, forMode: .common)
        self.timer = timer
    }

    func tick() {
        Task {
            let result = await cli(["tick", "--format", "text"])
            lastTick = Date()
            appendLog(result.stdout, result.stderr)
            lastError = result.status == 0 ? nil : (result.stderr.isEmpty ? "routine tick: exit \(result.status)" : result.stderr)
            await refresh()
        }
    }

    func refresh() async {
        if let s: EngineStatus = await decode(["status"]) { status = s }
        if let list: RoutineList = await decode(["ls"]) { routines = list.routines }
        if let log: [RunRecord] = await decode(["log", "-n", "8"]) { recent = log }
    }

    func runNow(_ id: String) {
        Task {
            let result = await cli(["run", id, "--format", "text"])
            appendLog(result.stdout, result.stderr)
            await refresh()
        }
    }

    func setStopped(_ stopped: Bool) {
        Task {
            _ = await cli([stopped ? "stop" : "start"])
            await refresh()
        }
    }

    func setLaunchAtLogin(_ enabled: Bool) {
        do {
            if enabled { try SMAppService.mainApp.register() } else { try SMAppService.mainApp.unregister() }
        } catch {
            lastError = "Ouverture au démarrage : \(error.localizedDescription)"
        }
        launchAtLogin = SMAppService.mainApp.status == .enabled
    }

    func openLog() {
        NSWorkspace.shared.open(URL(fileURLWithPath: Settings.logPath))
    }

    private func cli(_ arguments: [String]) async -> ProcessResult {
        var env = ProcessInfo.processInfo.environment
        env["PATH"] = "/opt/homebrew/bin:\(NSHomeDirectory())/.local/bin:/usr/bin:/bin:/usr/sbin:/sbin"
        return await Shell.run(Settings.nodePath, [Settings.cliPath] + arguments, environment: env)
    }

    private func decode<T: Decodable>(_ arguments: [String]) async -> T? {
        let result = await cli(arguments)
        guard result.status == 0 else {
            let failed = try? JSONDecoder().decode(Failure.self, from: result.stdout)
            lastError = failed?.error.message ?? (result.stderr.isEmpty ? "routine \(arguments.first ?? ""): exit \(result.status)" : result.stderr)
            return nil
        }
        return try? JSONDecoder().decode(Envelope<T>.self, from: result.stdout).result
    }

    private func appendLog(_ stdout: Data, _ stderr: String) {
        var data = stdout
        if !stderr.isEmpty { data.append(Data(stderr.utf8)) }
        guard !data.isEmpty else { return }
        let path = Settings.logPath
        if !FileManager.default.fileExists(atPath: path) { FileManager.default.createFile(atPath: path, contents: nil) }
        guard let handle = FileHandle(forWritingAtPath: path) else { return }
        handle.seekToEndOfFile()
        handle.write(data)
        try? handle.close()
    }
}
