// On-device text recognition with Apple's Vision framework. No install, nothing leaves the Mac.
// Build once:  swiftc -O -o tools/ocr tools/ocr.swift
// Use:         tools/ocr <image>   → prints the recognized text, top to bottom
import Foundation
import Vision
import AppKit

let args = CommandLine.arguments
guard args.count > 1, let image = NSImage(contentsOfFile: args[1]),
      let cg = image.cgImage(forProposedRect: nil, context: nil, hints: nil) else {
  FileHandle.standardError.write("usage: ocr <image>\n".data(using: .utf8)!); exit(2)
}
let request = VNRecognizeTextRequest()
request.recognitionLevel = .accurate
request.usesLanguageCorrection = true
let handler = VNImageRequestHandler(cgImage: cg, options: [:])
do { try handler.perform([request]) } catch { exit(1) }
let lines = (request.results ?? [])
  .sorted { $0.boundingBox.minY > $1.boundingBox.minY }
  .compactMap { $0.topCandidates(1).first?.string }
print(lines.joined(separator: "\n"))
