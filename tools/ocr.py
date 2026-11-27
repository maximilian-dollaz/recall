# On-device text recognition with Apple's Vision framework, for Macs without Xcode's tools.
# Same output as tools/ocr.swift: the recognized text, top to bottom. Nothing leaves the Mac.
# The installer points tools/ocr at this when it can't build the Swift version (needs pyobjc-framework-Vision).
#   python3 tools/ocr.py <image>
import sys

import Quartz
import Vision
from Foundation import NSURL


def main() -> int:
    if len(sys.argv) < 2:
        sys.stderr.write("usage: ocr <image>\n")
        return 2
    url = NSURL.fileURLWithPath_(sys.argv[1])
    source = Quartz.CGImageSourceCreateWithURL(url, None)
    image = Quartz.CGImageSourceCreateImageAtIndex(source, 0, None) if source else None
    if image is None:
        sys.stderr.write("usage: ocr <image>\n")
        return 2
    request = Vision.VNRecognizeTextRequest.alloc().init()
    request.setRecognitionLevel_(Vision.VNRequestTextRecognitionLevelAccurate)
    request.setUsesLanguageCorrection_(True)
    handler = Vision.VNImageRequestHandler.alloc().initWithCGImage_options_(image, {})
    ok, _ = handler.performRequests_error_([request], None)
    if not ok:
        return 1
    results = sorted(request.results() or [], key=lambda r: -r.boundingBox().origin.y)
    lines = [c[0].string() for c in (r.topCandidates_(1) for r in results) if c]
    print("\n".join(lines))
    return 0


if __name__ == "__main__":
    sys.exit(main())
