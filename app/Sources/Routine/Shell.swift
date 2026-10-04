import Foundation

struct ProcessResult: Sendable {
    let status: Int32
    let stdout: Data
    let stderr: String
}

enum Shell {
    // Runs a child process. Children of the app inherit it as their TCC responsible process.
    static func run(_ executable: String, _ arguments: [String], environment: [String: String]? = nil) async -> ProcessResult {
        await withCheckedContinuation { continuation in
            let process = Process()
            process.executableURL = URL(fileURLWithPath: executable)
            process.arguments = arguments
            if let environment { process.environment = environment }
            let dir = FileManager.default.temporaryDirectory
            let outURL = dir.appendingPathComponent("routine-\(UUID().uuidString).out")
            let errURL = dir.appendingPathComponent("routine-\(UUID().uuidString).err")
            FileManager.default.createFile(atPath: outURL.path, contents: nil)
            FileManager.default.createFile(atPath: errURL.path, contents: nil)
            guard let out = try? FileHandle(forWritingTo: outURL), let err = try? FileHandle(forWritingTo: errURL) else {
                continuation.resume(returning: ProcessResult(status: -1, stdout: Data(), stderr: "cannot create temporary files"))
                return
            }
            process.standardOutput = out
            process.standardError = err
            process.standardInput = FileHandle.nullDevice
            process.terminationHandler = { p in
                try? out.close()
                try? err.close()
                let stdout = (try? Data(contentsOf: outURL)) ?? Data()
                let stderr = (try? String(contentsOf: errURL, encoding: .utf8)) ?? ""
                try? FileManager.default.removeItem(at: outURL)
                try? FileManager.default.removeItem(at: errURL)
                continuation.resume(returning: ProcessResult(status: p.terminationStatus, stdout: stdout, stderr: stderr))
            }
            do {
                try process.run()
            } catch {
                try? out.close()
                try? err.close()
                continuation.resume(returning: ProcessResult(status: -1, stdout: Data(), stderr: error.localizedDescription))
            }
        }
    }
}
