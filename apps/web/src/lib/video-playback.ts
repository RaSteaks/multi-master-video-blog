import type { VideoMaster } from "./directus";

type PlaybackMaster = Pick<VideoMaster,
  "id" | "type" | "is_default" | "verification_status" | "hls_url" | "derived_from_master_id"
>;

export function isPlayableMaster(master: PlaybackMaster) {
  return master.verification_status === "ready" && Boolean(master.hls_url?.trim());
}

export function playbackErrorMessage(error: unknown) {
  if (error && typeof error === "object") {
    if ("message" in error && typeof error.message === "string" && error.message.trim()) {
      return error.message;
    }
    if ("code" in error && typeof error.code === "number") {
      return `Playback failed (Shaka ${error.code}).`;
    }
  }
  return "Playback failed for this master.";
}

export function getDefaultMaster<T extends PlaybackMaster>(masters: T[]) {
  const playable = masters.filter(isPlayableMaster);
  return playable.find((master) => master.is_default === true || master.is_default === 1)
    ?? playable.find((master) => master.type === "sdr")
    ?? playable[0];
}

export function getSdrFallback<T extends PlaybackMaster>(masters: T[], failedMaster: T | null) {
  if (!failedMaster || failedMaster.type === "sdr") return undefined;
  const sdr = masters.filter((master) =>
    master.type === "sdr" && master.id !== failedMaster.id && isPlayableMaster(master)
  );
  return sdr.find((master) => String(master.derived_from_master_id) === String(failedMaster.id))
    ?? getDefaultMaster(sdr);
}
