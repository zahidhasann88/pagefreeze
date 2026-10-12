/**
 * pixelmatch v6 ships without type declarations and @types/pixelmatch targets v7, whose
 * signature differs. This local declaration matches the v6 API we actually use.
 */
declare module 'pixelmatch' {
  export interface PixelmatchOptions {
    /** Per-pixel colour distance threshold, 0 (exact) to 1 (anything matches). */
    threshold?: number;
    /** Include anti-aliased pixels in the diff count. */
    includeAA?: boolean;
    /** Blend factor for the dimmed unchanged pixels in the output image. */
    alpha?: number;
    /** Colour of changed pixels. */
    diffColor?: [number, number, number];
    /** Colour of anti-aliased pixels when includeAA is false. */
    diffColorAlt?: [number, number, number];
    /** Draw a bounding box around differing clusters. */
    diffMask?: boolean;
  }

  /**
   * Compare two images of identical dimensions. Returns the number of differing pixels.
   * `output` may be null to skip building the diff image.
   */
  export default function pixelmatch(
    img1: Uint8Array | Uint8ClampedArray | Buffer,
    img2: Uint8Array | Uint8ClampedArray | Buffer,
    output: Uint8Array | Uint8ClampedArray | Buffer | null,
    width: number,
    height: number,
    options?: PixelmatchOptions,
  ): number;
}
