/** Bounded public provenance, separate from the encoded playback contract. */
export type SourceFormat = {
  version: 1;
  container: "imf" | "embedded" | "unknown";
  applicationIds: string[];
  colorModel: "rgb" | "ycbcr" | "mixed" | "unknown";
  codec: string | null;
  bitDepth: number | null;
  primaries: string | null;
  transfer: string | null;
  range: "full" | "limited" | "custom" | "unknown";
  dynamicRange: "pq" | "hlg" | "sdr" | "unknown";
  compositionCount: number | null;
  segmentCount: number | null;
  packageKind: "self_contained" | "external_references" | "unknown";
  missingResources: number | null;
  preset: null;
  dolbyVision: {
    status: "declared" | "candidate" | "unlinked" | "verified_rpu" | "unknown";
    storage: ("isxd" | "phdr" | "xml" | "rpu")[];
    validation: "bitstream_verified" | "not_validated";
    playbackUse: "embedded_in_output" | "applied_to_conversion" | "not_applied" | "unknown";
  };
};
export function sanitizeSourceFormat(input: unknown): SourceFormat | null;
export function sourceFormatFromProbe(probe?: Record<string, unknown>): SourceFormat | null;
export function sourceFormatForPlayback(source: unknown, outputContract?: Record<string, unknown>, conversion?: unknown): SourceFormat | null;
