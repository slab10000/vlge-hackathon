import Foundation
import RealityKit

// Usage: photogram <inputFramesDir> <outputModelPath(.usdz)> <detail: preview|reduced|medium|full|raw>
let args = CommandLine.arguments
guard args.count >= 4 else {
    print("usage: photogram <framesDir> <out.usdz> <detail>")
    exit(1)
}
let inputURL = URL(fileURLWithPath: args[1], isDirectory: true)
let outputURL = URL(fileURLWithPath: args[2])
let detailArg = args[3]

guard PhotogrammetrySession.isSupported else {
    print("ERROR: PhotogrammetrySession not supported on this Mac")
    exit(2)
}

let detail: PhotogrammetrySession.Request.Detail
switch detailArg {
case "preview": detail = .preview
case "reduced": detail = .reduced
case "medium": detail = .medium
case "full": detail = .full
case "raw": detail = .raw
default: detail = .reduced
}

var config = PhotogrammetrySession.Configuration()
config.sampleOrdering = .sequential      // frames come from one continuous video
config.featureSensitivity = .normal
config.isObjectMaskingEnabled = false    // reconstruct the whole scene, not one object

let session: PhotogrammetrySession
do {
    session = try PhotogrammetrySession(input: inputURL, configuration: config)
} catch {
    print("ERROR creating session: \(error)")
    exit(3)
}

let done = DispatchSemaphore(value: 0)
var exitCode: Int32 = 0

Task {
    do {
        for try await output in session.outputs {
            switch output {
            case .processingComplete:
                print("DONE processingComplete")
                done.signal()
            case .requestError(let request, let error):
                print("ERROR request \(request): \(error)")
                exitCode = 4
                done.signal()
            case .requestComplete(let request, let result):
                print("COMPLETE \(request) -> \(result)")
            case .requestProgress(_, let fraction):
                let pct = Int(fraction * 100)
                if pct % 5 == 0 { print("PROGRESS \(pct)%") }
            case .inputComplete:
                print("inputComplete")
            case .invalidSample(let id, let reason):
                print("invalidSample \(id): \(reason)")
            case .skippedSample(let id):
                print("skippedSample \(id)")
            case .automaticDownsampling:
                print("automaticDownsampling")
            case .processingCancelled:
                print("cancelled")
                exitCode = 5
                done.signal()
            default:
                break // progress-info and other chatty events: PROGRESS lines above are enough
            }
        }
    } catch {
        print("ERROR stream: \(error)")
        exitCode = 6
        done.signal()
    }
}

do {
    try session.process(requests: [.modelFile(url: outputURL, detail: detail)])
} catch {
    print("ERROR process: \(error)")
    exit(7)
}

done.wait()
exit(exitCode)
