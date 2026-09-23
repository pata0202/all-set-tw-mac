// Reads an image from stdin, prints OCR candidates (best first), one per line.
// Build: swiftc -O homelab/ocr.swift -o homelab/ocr
import Foundation
import ImageIO
import Vision

let data = FileHandle.standardInput.readDataToEndOfFile()
guard let source = CGImageSourceCreateWithData(data as CFData, nil),
      let image = CGImageSourceCreateImageAtIndex(source, 0, nil)
else {
    FileHandle.standardError.write("invalid image\n".data(using: .utf8)!)
    exit(2)
}

let request = VNRecognizeTextRequest()
request.recognitionLevel = .accurate
request.usesLanguageCorrection = false
request.recognitionLanguages = ["en-US"]
request.minimumTextHeight = 0

try VNImageRequestHandler(cgImage: image).perform([request])
let observations = (request.results ?? []).sorted { $0.boundingBox.minX < $1.boundingBox.minX }

// Whole line from each observation's best guess, then alternates when there is one text box.
var lines = [observations.compactMap { $0.topCandidates(1).first?.string }.joined()]
if observations.count == 1 {
    lines += observations[0].topCandidates(10).dropFirst().map(\.string)
}
print(lines.joined(separator: "\n"))
