import AppKit
import SwiftUI

@main
struct RoutineApp: App {
    @StateObject private var engine = Engine()
    @StateObject private var access = Access()

    var body: some Scene {
        MenuBarExtra {
            MenuContent(engine: engine)
        } label: {
            Image(systemName: icon)
                .task { engine.start() }
        }
        Window("Accès de Routine", id: "access") {
            AccessView(access: access)
        }
        .windowResizability(.contentSize)
    }

    private var icon: String {
        if engine.status?.stopped == true { return "pause.circle" }
        if engine.hasFailure || engine.lastError != nil { return "exclamationmark.arrow.circlepath" }
        return "clock.arrow.circlepath"
    }
}

struct MenuContent: View {
    @ObservedObject var engine: Engine
    @Environment(\.openWindow) private var openWindow

    var body: some View {
        if let status = engine.status {
            Text(status.stopped ? "Arrêté : aucune routine ne part" : "Actif")
            Text("\(status.routines) routine(s), \(status.active) active(s), \(status.running.count) en cours")
            if status.invalid > 0 { Text("\(status.invalid) fiche(s) invalide(s) : voir `routine check`") }
        } else {
            Text("Moteur injoignable")
        }
        if let error = engine.lastError {
            Text("Erreur : \(error.prefix(80))")
        }
        Divider()
        Section("Derniers passages") {
            if engine.recent.isEmpty { Text("Aucun") }
            ForEach(engine.recent.reversed(), id: \.key) { run in
                Text("\(Self.time(run.started))  \(run.id)  \(run.status)\(run.manual == true ? " (manuel)" : "")")
            }
        }
        Divider()
        Menu("Exécuter maintenant") {
            if engine.routines.isEmpty { Text("Aucune routine") }
            ForEach(engine.routines) { routine in
                Button(routine.id) { engine.runNow(routine.id) }.disabled(routine.running)
            }
        }
        Toggle("Arrêt d'urgence", isOn: Binding(get: { engine.status?.stopped ?? false }, set: { engine.setStopped($0) }))
        Button("Accès…") {
            NSApp.activate(ignoringOtherApps: true)
            openWindow(id: "access")
        }
        Button("Ouvrir le journal") { engine.openLog() }
        Toggle("Ouvrir au démarrage", isOn: Binding(get: { engine.launchAtLogin }, set: { engine.setLaunchAtLogin($0) }))
        Divider()
        Button("Quitter Routine") { NSApp.terminate(nil) }.keyboardShortcut("q")
    }

    static func time(_ iso: String) -> String {
        let parser = ISO8601DateFormatter()
        parser.formatOptions = [.withInternetDateTime, .withFractionalSeconds]
        guard let date = parser.date(from: iso) else { return iso }
        return date.formatted(.dateTime.day().month(.twoDigits).hour().minute())
    }
}

struct AccessView: View {
    @ObservedObject var access: Access

    var body: some View {
        VStack(alignment: .leading, spacing: 12) {
            Text("Les routines lancées par Routine utilisent les accès accordés à Routine.")
                .foregroundStyle(.secondary)
            List(access.items) { item in
                HStack(alignment: .top, spacing: 10) {
                    Image(systemName: item.state.symbol)
                        .foregroundStyle(color(item.state))
                        .frame(width: 18)
                    VStack(alignment: .leading, spacing: 2) {
                        Text(item.name).bold()
                        Text(item.detail).font(.caption).foregroundStyle(.secondary)
                        Text(item.state.label).font(.caption)
                    }
                    Spacer()
                    if item.state != .granted {
                        Button(item.kind == .macosHelper ? "Ouvrir macos-cli" : "Demander") {
                            Task { await access.request(item.kind) }
                        }
                    }
                }
                .padding(.vertical, 4)
            }
            .frame(minWidth: 560, minHeight: 520)
            HStack {
                Spacer()
                Button("Actualiser") { Task { await access.refresh() } }.disabled(access.busy)
            }
        }
        .padding()
        .task { await access.refresh() }
    }

    private func color(_ state: AccessState) -> Color {
        switch state {
        case .granted: .green
        case .denied: .red
        case .notDetermined: .secondary
        case .partial, .unknown: .orange
        }
    }
}
