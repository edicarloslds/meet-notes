// swift-tools-version: 5.9

import PackageDescription

let package = Package(
  name: "AppleSpeechHelper",
  platforms: [.macOS(.v13)],
  products: [
    .executable(name: "apple-speech-helper", targets: ["AppleSpeechHelper"])
  ],
  targets: [
    .executableTarget(
      name: "AppleSpeechHelper",
      exclude: ["Info.plist"],
      linkerSettings: [
        .unsafeFlags([
          "-Xlinker", "-sectcreate",
          "-Xlinker", "__TEXT",
          "-Xlinker", "__info_plist",
          "-Xlinker", "Sources/AppleSpeechHelper/Info.plist"
        ])
      ]
    )
  ]
)
