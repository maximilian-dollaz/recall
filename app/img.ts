// Picture conversions that run the same on macOS and on a Linux server.
// macOS ships `sips`; Linux uses libvips (`vipsthumbnail`, `vipsheader`), which reads HEIC
// through libheif and turns photos the right way up from their EXIF.

export const MAC = process.platform === "darwin";

/** The command that writes `src` as a JPEG at `out`, at most `px` on its long side, quality `q`. Never enlarges. */
export function jpegArgs(src: string, out: string, px: number | string, q: number | string = 80): string[] {
  return MAC
    ? ["sips", "-s", "format", "jpeg", "-s", "formatOptions", String(q), "-Z", String(px), src, "--out", out]
    : ["vipsthumbnail", src, "-s", `${px}x${px}>`, "-o", `${out}[Q=${q},strip]`];
}

/** The command that prints a photo's EXIF date taken; its output holds "YYYY:MM:DD". */
export function takenArgs(src: string): string[] {
  return MAC ? ["sips", "-g", "creation", src] : ["vipsheader", "-f", "exif-ifd2-DateTimeOriginal", src];
}
