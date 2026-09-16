const test = require("node:test");
const assert = require("node:assert/strict");
const {
  acceptsEncoding,
  fileEtag,
  ifRangeMatches,
  parseByteRange,
  requestIsFresh
} = require("../src/http-utils.cjs");

test("acceptsEncoding respects explicit and wildcard quality values", () => {
  assert.equal(acceptsEncoding("br, gzip", "gzip"), true);
  assert.equal(acceptsEncoding("br, gzip;q=0", "gzip"), false);
  assert.equal(acceptsEncoding("*;q=0.5", "gzip"), true);
  assert.equal(acceptsEncoding("*;q=1, gzip;q=0", "gzip"), false);
  assert.equal(acceptsEncoding("", "gzip"), false);
});

test("parseByteRange supports bounded, open, and suffix byte ranges", () => {
  assert.deepEqual(parseByteRange("bytes=10-19", 100), {
    start: 10,
    end: 19,
    length: 10
  });
  assert.deepEqual(parseByteRange("bytes=90-", 100), {
    start: 90,
    end: 99,
    length: 10
  });
  assert.deepEqual(parseByteRange("bytes=-12", 100), {
    start: 88,
    end: 99,
    length: 12
  });
  assert.deepEqual(parseByteRange("bytes=0-999", 100), {
    start: 0,
    end: 99,
    length: 100
  });
});

test("parseByteRange rejects multiple and unsatisfiable ranges", () => {
  assert.equal(parseByteRange(null, 100), null);
  assert.deepEqual(parseByteRange("bytes=0-1,4-5", 100), {
    error: "unsatisfiable"
  });
  assert.deepEqual(parseByteRange("bytes=100-", 100), {
    error: "unsatisfiable"
  });
  assert.deepEqual(parseByteRange("bytes=-0", 100), {
    error: "unsatisfiable"
  });
});

test("file validators honor ETag precedence and second-level dates", () => {
  const stat = { size: 4096, mtimeMs: Date.UTC(2026, 0, 2, 3, 4, 5, 750) };
  const etag = fileEtag(stat);
  assert.equal(requestIsFresh({ "if-none-match": etag }, etag, stat.mtimeMs), true);
  assert.equal(
    requestIsFresh(
      {
        "if-none-match": 'W/"different"',
        "if-modified-since": new Date(stat.mtimeMs + 60_000).toUTCString()
      },
      etag,
      stat.mtimeMs
    ),
    false
  );
  assert.equal(
    requestIsFresh(
      { "if-modified-since": new Date(stat.mtimeMs).toUTCString() },
      etag,
      stat.mtimeMs
    ),
    true
  );
  assert.equal(ifRangeMatches(etag, etag, stat.mtimeMs), true);
  assert.equal(ifRangeMatches('W/"different"', etag, stat.mtimeMs), false);
});
