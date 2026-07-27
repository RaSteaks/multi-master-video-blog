const test = require("node:test");
const assert = require("node:assert/strict");
const {
  detectImageMime,
  manifestPhotoPairKey,
  pairAlbumFiles,
  photoPairKey,
  reconcileAlbumBatchResources,
  rollbackAlbumBatch,
  validateAlbumBatchLimits,
  validateHdrProbe,
  validatePairedAspectRatio,
  validateSdrProbe
} = require("../src/album-utils.cjs");

test("photoPairKey removes the final extension and ignores case", () => {
  assert.equal(photoPairKey("Night.City.Final.JPG"), "night.city.final");
  assert.equal(photoPairKey("NIGHT.CITY.FINAL.avif"), "night.city.final");
});

test("manifestPhotoPairKey preserves dots in an already normalized pair key", () => {
  const clientKey = photoPairKey("Night.City.Final.JPG");
  assert.equal(clientKey, "night.city.final");
  assert.equal(manifestPhotoPairKey({ key: clientKey }), clientKey);
  assert.equal(
    manifestPhotoPairKey({ filename: "Night.City.Final.JPG" }),
    clientKey
  );
});

test("pairAlbumFiles keeps SDR-only photos and pairs matching HDR files", () => {
  const pairs = pairAlbumFiles(
    [{ originalName: "one.jpg" }, { originalName: "two.webp" }],
    [{ originalName: "ONE.avif" }]
  );

  assert.equal(pairs.length, 2);
  assert.equal(pairs[0].key, "one");
  assert.equal(pairs[0].hdr.originalName, "ONE.avif");
  assert.equal(pairs[1].key, "two");
  assert.equal(pairs[1].hdr, null);
});

test("pairAlbumFiles rejects duplicate stems and orphan HDR files", () => {
  assert.throws(
    () =>
      pairAlbumFiles(
        [{ originalName: "same.jpg" }, { originalName: "SAME.png" }],
        []
      ),
    /duplicated/
  );
  assert.throws(
    () =>
      pairAlbumFiles(
        [{ originalName: "one.jpg" }],
        [{ originalName: "two.avif" }]
      ),
    /matching SDR/
  );
});

test("detectImageMime recognizes supported signatures", () => {
  assert.equal(
    detectImageMime(Buffer.from([0xff, 0xd8, 0xff, 0xe0])),
    "image/jpeg"
  );
  assert.equal(
    detectImageMime(
      Buffer.from([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a])
    ),
    "image/png"
  );
  assert.equal(
    detectImageMime(Buffer.from("RIFF0000WEBP", "ascii")),
    "image/webp"
  );
  assert.equal(
    detectImageMime(Buffer.from("\0\0\0\u0018ftypavif\0\0\0\0", "binary")),
    "image/avif"
  );
  assert.equal(detectImageMime(Buffer.from("not-an-image")), null);
});

test("validateHdrProbe accepts static 10-bit PQ and 12-bit HLG AVIF streams", () => {
  assert.deepEqual(
    validateHdrProbe({
      codec_name: "av1",
      width: 4000,
      height: 3000,
      pix_fmt: "yuv420p10le",
      color_transfer: "smpte2084",
      color_primaries: "bt2020",
      nb_frames: "1"
    }),
    {
      width: 4000,
      height: 3000,
      transfer: "pq",
      primaries: "bt2020",
      bitDepth: 10
    }
  );

  assert.equal(
    validateHdrProbe({
      codec_name: "av1",
      width: 3840,
      height: 2160,
      bits_per_raw_sample: "12",
      color_transfer: "arib-std-b67"
    }).transfer,
    "hlg"
  );
});

test("validateHdrProbe rejects 8-bit, SDR-transfer, and animated AVIF", () => {
  const base = {
    codec_name: "av1",
    width: 1920,
    height: 1080,
    pix_fmt: "yuv420p",
    color_transfer: "smpte2084"
  };

  assert.throws(() => validateHdrProbe(base), /10-bit or 12-bit/);
  assert.throws(
    () =>
      validateHdrProbe({
        ...base,
        pix_fmt: "yuv420p10le",
        color_transfer: "bt709"
      }),
    /PQ or HLG/
  );
  assert.throws(
    () =>
      validateHdrProbe({
        ...base,
        pix_fmt: "yuv420p10le",
        nb_read_frames: "2"
      }),
    /Animated/
  );
});

test("validateSdrProbe rejects HDR transfer metadata", () => {
  assert.deepEqual(
    validateSdrProbe({ width: 1600, height: 900, color_transfer: "bt709" }),
    { width: 1600, height: 900 }
  );
  assert.throws(
    () =>
      validateSdrProbe({
        width: 1600,
        height: 900,
        color_transfer: "smpte2084"
      }),
    /contains an HDR transfer/
  );
});

test("validatePairedAspectRatio allows resized pairs but rejects a mismatch", () => {
  assert.equal(
    validatePairedAspectRatio(
      { width: 4000, height: 3000 },
      { width: 2000, height: 1500 }
    ),
    true
  );
  assert.throws(
    () =>
      validatePairedAspectRatio(
        { width: 4000, height: 3000 },
        { width: 1920, height: 1080 }
      ),
    /same aspect ratio/
  );
});

test("validateAlbumBatchLimits enforces photo, file, and batch limits", () => {
  const limits = {
    maxPhotos: 2,
    maxFileBytes: 10,
    maxBatchBytes: 20
  };
  assert.deepEqual(
    validateAlbumBatchLimits(
      [{ originalName: "a.jpg", size: 8 }, { originalName: "b.jpg", size: 7 }],
      [{ originalName: "a.avif", size: 5 }],
      limits
    ),
    { photoCount: 2, fileCount: 3, totalBytes: 20 }
  );
  assert.throws(
    () =>
      validateAlbumBatchLimits(
        [{ size: 1 }, { size: 1 }, { size: 1 }],
        [],
        limits
      ),
    /At most 2/
  );
  assert.throws(
    () =>
      validateAlbumBatchLimits(
        [{ originalName: "large.jpg", size: 11 }],
        [],
        limits
      ),
    /large\.jpg exceeds 10/
  );
  assert.throws(
    () =>
      validateAlbumBatchLimits(
        [{ size: 10 }, { size: 10 }],
        [{ size: 1 }],
        limits
      ),
    /exceeds 20/
  );
});

test("rollbackAlbumBatch removes records before files in reverse order and continues on errors", async () => {
  const calls = [];
  const errors = await rollbackAlbumBatch({
    photoIds: [1, 2],
    fileIds: ["sdr", "hdr"],
    deletePhoto: async (id) => {
      calls.push(`photo:${id}`);
      if (id === 1) {
        throw new Error("record cleanup failed");
      }
    },
    deleteFile: async (id) => {
      calls.push(`file:${id}`);
    }
  });

  assert.deepEqual(calls, ["photo:2", "photo:1", "file:hdr", "file:sdr"]);
  assert.equal(errors.length, 1);
  assert.equal(errors[0].kind, "photo");
  assert.equal(errors[0].id, 1);
});

test("reconcileAlbumBatchResources discovers ambiguous files and their photo records", async () => {
  const photoLookups = [];
  const reconciled = await reconcileAlbumBatchResources({
    photoIds: [1],
    fileIds: ["known-sdr"],
    reconciliationTags: ["batch:2:sdr", "batch:2:hdr"],
    findFileByTag: async (tag) =>
      tag.endsWith(":sdr") ? "unknown-sdr" : "unknown-hdr",
    findPhotosBySdrFiles: async (fileIds) => {
      photoLookups.push(fileIds);
      return [{ id: 2 }];
    }
  });

  assert.deepEqual(reconciled.photoIds, ["1", "2"]);
  assert.deepEqual(
    new Set(reconciled.fileIds),
    new Set(["known-sdr", "unknown-sdr", "unknown-hdr"])
  );
  assert.deepEqual(
    new Set(photoLookups[0]),
    new Set(["known-sdr", "unknown-sdr", "unknown-hdr"])
  );
  assert.deepEqual(reconciled.errors, []);
});
