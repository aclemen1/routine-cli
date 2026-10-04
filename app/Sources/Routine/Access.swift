import AppKit
import ApplicationServices
import Contacts
import EventKit
import Foundation
import Photos

enum AccessState: Equatable {
    case granted
    case partial(String)
    case denied
    case notDetermined
    case unknown(String)

    var label: String {
        switch self {
        case .granted: "Accordé"
        case .partial(let detail): detail
        case .denied: "Refusé"
        case .notDetermined: "Pas encore demandé"
        case .unknown(let detail): detail
        }
    }

    var symbol: String {
        switch self {
        case .granted: "checkmark.circle.fill"
        case .partial, .unknown: "questionmark.circle.fill"
        case .denied: "xmark.circle.fill"
        case .notDetermined: "circle.dashed"
        }
    }
}

enum AccessKind: Hashable {
    case fullDisk, accessibility, reminders, calendar, contacts, photos, macosHelper
    case automation(bundleID: String)
}

struct AccessItem: Identifiable {
    let kind: AccessKind
    let name: String
    let detail: String
    var state: AccessState = .unknown("…")
    var id: AccessKind { kind }
}

enum SettingsPane {
    static func open(_ anchor: String) {
        if let url = URL(string: "x-apple.systempreferences:com.apple.preference.security?\(anchor)") {
            NSWorkspace.shared.open(url)
        }
    }
}

@MainActor
final class Access: ObservableObject {
    @Published private(set) var items: [AccessItem] = []
    @Published private(set) var busy = false

    static let defaultAutomationTargets = [
        "com.apple.finder", "com.apple.systemevents", "com.apple.mail", "com.apple.Notes", "com.apple.MobileSMS",
    ]

    init() {
        let targets = UserDefaults.standard.stringArray(forKey: "automationTargets") ?? Self.defaultAutomationTargets
        items = [
            AccessItem(kind: .fullDisk, name: "Accès complet au disque", detail: "Lire ~/Library (Mail, Messages, Safari…). S'accorde seulement dans les Réglages."),
            AccessItem(kind: .accessibility, name: "Accessibilité", detail: "Piloter l'interface d'autres apps (clavier, souris, System Events)."),
        ] + targets.map { id in
            AccessItem(kind: .automation(bundleID: id), name: "Automation : \(Self.appName(id))", detail: "Envoyer des Apple Events (osascript) à \(id).")
        } + [
            AccessItem(kind: .reminders, name: "Rappels", detail: "Seulement pour une routine qui appelle EventKit elle-même."),
            AccessItem(kind: .calendar, name: "Calendrier", detail: "Seulement pour une routine qui appelle EventKit elle-même."),
            AccessItem(kind: .contacts, name: "Contacts", detail: "Seulement pour une routine qui lit les contacts elle-même."),
            AccessItem(kind: .photos, name: "Photos", detail: "Seulement pour une routine qui lit la photothèque elle-même."),
            AccessItem(kind: .macosHelper, name: "Helper macos-cli", detail: "Porte les accès de `macos` (Rappels, Calendrier, Contacts, Photos, disque). Aucun accès de Routine n'est alors nécessaire."),
        ]
    }

    static func appName(_ bundleID: String) -> String {
        guard let url = NSWorkspace.shared.urlForApplication(withBundleIdentifier: bundleID) else { return bundleID }
        return FileManager.default.displayName(atPath: url.path).replacingOccurrences(of: ".app", with: "")
    }

    func refresh() async {
        busy = true
        for index in items.indices {
            items[index].state = await check(items[index].kind)
        }
        busy = false
    }

    func request(_ kind: AccessKind) async {
        NSApp.activate(ignoringOtherApps: true)
        switch kind {
        case .fullDisk:
            _ = FileHandle(forReadingAtPath: Self.protectedFile)
            SettingsPane.open("Privacy_AllFiles")
        case .accessibility:
            // Value of kAXTrustedCheckOptionPrompt, a global var Swift 6 rejects as not concurrency-safe.
            let options = ["AXTrustedCheckOptionPrompt": true] as CFDictionary
            if !AXIsProcessTrustedWithOptions(options) { SettingsPane.open("Privacy_Accessibility") }
        case .automation(let bundleID):
            if case .denied = await check(kind) {
                SettingsPane.open("Privacy_Automation")
            } else {
                await Self.requestAutomation(bundleID)
            }
        case .reminders:
            if case .denied = await check(kind) { SettingsPane.open("Privacy_Reminders") } else { _ = try? await EKEventStore().requestFullAccessToReminders() }
        case .calendar:
            if case .denied = await check(kind) { SettingsPane.open("Privacy_Calendars") } else { _ = try? await EKEventStore().requestFullAccessToEvents() }
        case .contacts:
            if case .denied = await check(kind) { SettingsPane.open("Privacy_Contacts") } else { _ = try? await CNContactStore().requestAccess(for: .contacts) }
        case .photos:
            if case .denied = await check(kind) { SettingsPane.open("Privacy_Photos") } else { _ = await PHPhotoLibrary.requestAuthorization(for: .readWrite) }
        case .macosHelper:
            if let url = NSWorkspace.shared.urlForApplication(withBundleIdentifier: "app.macos-cli.gui") {
                NSWorkspace.shared.open(url)
            }
        }
        if let index = items.firstIndex(where: { $0.kind == kind }) {
            items[index].state = await check(kind)
        }
    }

    private static let protectedFile = ("~/Library/Application Support/com.apple.TCC/TCC.db" as NSString).expandingTildeInPath

    private func check(_ kind: AccessKind) async -> AccessState {
        switch kind {
        case .fullDisk:
            if let handle = FileHandle(forReadingAtPath: Self.protectedFile) {
                try? handle.close()
                return .granted
            }
            return .denied
        case .accessibility:
            return AXIsProcessTrusted() ? .granted : .denied
        case .automation(let bundleID):
            return await Self.automationState(bundleID)
        case .reminders:
            return Self.eventKitState(EKEventStore.authorizationStatus(for: .reminder))
        case .calendar:
            return Self.eventKitState(EKEventStore.authorizationStatus(for: .event))
        case .contacts:
            switch CNContactStore.authorizationStatus(for: .contacts) {
            case .authorized: return .granted
            case .limited: return .partial("Accès limité")
            case .denied, .restricted: return .denied
            case .notDetermined: return .notDetermined
            @unknown default: return .unknown("État inconnu")
            }
        case .photos:
            switch PHPhotoLibrary.authorizationStatus(for: .readWrite) {
            case .authorized: return .granted
            case .limited: return .partial("Accès limité")
            case .denied, .restricted: return .denied
            case .notDetermined: return .notDetermined
            @unknown default: return .unknown("État inconnu")
            }
        case .macosHelper:
            return await Self.macosHelperState()
        }
    }

    private static func eventKitState(_ status: EKAuthorizationStatus) -> AccessState {
        switch status {
        case .fullAccess: .granted
        case .writeOnly: .partial("Ajout seulement")
        case .denied, .restricted: .denied
        case .notDetermined: .notDetermined
        @unknown default: .unknown("État inconnu")
        }
    }

    private static func automationState(_ bundleID: String) async -> AccessState {
        let status = await determineAutomation(bundleID, ask: false)
        switch status {
        case noErr: return .granted
        case OSStatus(errAEEventNotPermitted): return .denied
        case OSStatus(errAEEventWouldRequireUserConsent): return .notDetermined
        case OSStatus(procNotFound): return .unknown("App fermée : état non vérifiable")
        default: return .unknown("Erreur \(status)")
        }
    }

    private static func requestAutomation(_ bundleID: String) async {
        if NSRunningApplication.runningApplications(withBundleIdentifier: bundleID).isEmpty,
           let url = NSWorkspace.shared.urlForApplication(withBundleIdentifier: bundleID) {
            let configuration = NSWorkspace.OpenConfiguration()
            configuration.activates = false
            _ = try? await NSWorkspace.shared.openApplication(at: url, configuration: configuration)
            try? await Task.sleep(for: .seconds(2))
        }
        _ = await determineAutomation(bundleID, ask: true)
    }

    // AEDeterminePermissionToAutomateTarget blocks while the consent prompt is shown.
    private static func determineAutomation(_ bundleID: String, ask: Bool) async -> OSStatus {
        await Task.detached {
            let target = NSAppleEventDescriptor(bundleIdentifier: bundleID)
            guard var desc = target.aeDesc?.pointee else { return OSStatus(procNotFound) }
            return AEDeterminePermissionToAutomateTarget(&desc, typeWildCard, typeWildCard, ask)
        }.value
    }

    private struct MacosStatus: Decodable {
        struct Result: Decodable {
            let helperInstalled: Bool
            let tccGranted: Bool
        }
        let result: Result
    }

    private static func macosHelperState() async -> AccessState {
        let macos = ["/opt/homebrew/bin/macos", "/usr/local/bin/macos"].first { FileManager.default.isExecutableFile(atPath: $0) }
        guard let macos else { return .unknown("macos-cli absent") }
        let result = await Shell.run(macos, ["meta", "status", "--format", "json"])
        guard result.status == 0, let status = try? JSONDecoder().decode(MacosStatus.self, from: result.stdout) else {
            return .unknown("`macos meta status` a échoué")
        }
        if !status.result.helperInstalled { return .notDetermined }
        return status.result.tccGranted ? .granted : .partial("Helper sans accès")
    }
}
