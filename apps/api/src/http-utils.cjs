function fileEtag(stat) {
  return `\"${Number(stat.size).toString(16)}-${Math.trunc(
    Number(stat.mtimeMs)
  ).toString(16)}\"`;
}

function acceptsEncoding(headerValue, targetEncoding) {
  const target = String(targetEncoding || "").trim().toLowerCase();
  if (!target) return false;

  let wildcardQuality = null;
  let targetQuality = null;
  for (const entry of String(headerValue || "").split(",")) {
    const [rawEncoding, ...parameters] = entry.split(";");
    const encoding = rawEncoding.trim().toLowerCase();
    if (!encoding) continue;
    const qualityParameter = parameters.find((parameter) =>
      /^\s*q\s*=/i.test(parameter)
    );
    const quality = qualityParameter
      ? Number(qualityParameter.split("=").slice(1).join("=").trim())
      : 1;
    const normalizedQuality = Number.isFinite(quality)
      ? Math.min(1, Math.max(0, quality))
      : 0;

    if (encoding === target) targetQuality = normalizedQuality;
    if (encoding === "*") wildcardQuality = normalizedQuality;
  }

  return (targetQuality ?? wildcardQuality ?? 0) > 0;
}

function requestIsFresh(headers, etag, mtimeMs) {
  const ifNoneMatch = String(headers["if-none-match"] || "").trim();
  if (ifNoneMatch) {
    return (
      ifNoneMatch === "*" ||
      ifNoneMatch
        .split(",")
        .map((value) => value.trim())
        .includes(etag)
    );
  }

  const ifModifiedSince = Date.parse(
    String(headers["if-modified-since"] || "")
  );
  return (
    Number.isFinite(ifModifiedSince) &&
    Math.trunc(Number(mtimeMs) / 1000) <= Math.trunc(ifModifiedSince / 1000)
  );
}

function ifRangeMatches(value, etag, mtimeMs) {
  const ifRange = String(value || "").trim();
  if (!ifRange) return true;
  if (ifRange.startsWith("W/") || ifRange.startsWith('"')) {
    return ifRange === etag;
  }

  const date = Date.parse(ifRange);
  return (
    Number.isFinite(date) &&
    Math.trunc(Number(mtimeMs) / 1000) <= Math.trunc(date / 1000)
  );
}

function parseByteRange(value, size) {
  if (!value) return null;
  if (!Number.isSafeInteger(size) || size < 0) {
    return { error: "invalid-size" };
  }

  const match = String(value).trim().match(/^bytes=(\d*)-(\d*)$/i);
  if (!match || (!match[1] && !match[2]) || size === 0) {
    return { error: "unsatisfiable" };
  }

  let start;
  let end;
  if (!match[1]) {
    const suffixLength = Number(match[2]);
    if (!Number.isSafeInteger(suffixLength) || suffixLength <= 0) {
      return { error: "unsatisfiable" };
    }
    start = Math.max(size - suffixLength, 0);
    end = size - 1;
  } else {
    start = Number(match[1]);
    end = match[2] ? Number(match[2]) : size - 1;
    if (
      !Number.isSafeInteger(start) ||
      !Number.isSafeInteger(end) ||
      start < 0 ||
      start >= size ||
      end < start
    ) {
      return { error: "unsatisfiable" };
    }
    end = Math.min(end, size - 1);
  }

  return { start, end, length: end - start + 1 };
}

module.exports = {
  acceptsEncoding,
  fileEtag,
  ifRangeMatches,
  parseByteRange,
  requestIsFresh
};
