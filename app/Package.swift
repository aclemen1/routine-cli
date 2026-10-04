// swift-tools-version:6.0
import PackageDescription

let package = Package(
    name: "Routine",
    platforms: [.macOS(.v14)],
    targets: [
        .executableTarget(
            name: "Routine",
            path: "Sources/Routine",
            linkerSettings: [
                // TCC reads the Info.plist embedded in the executable, not only the bundle's copy.
                .unsafeFlags([
                    "-Xlinker", "-sectcreate",
                    "-Xlinker", "__TEXT",
                    "-Xlinker", "__info_plist",
                    "-Xlinker", "Resources/Info.plist",
                ]),
            ]
        ),
    ]
)
