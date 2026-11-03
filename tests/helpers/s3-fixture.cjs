const http = require("node:http");
const crypto = require("node:crypto");
const assert = require("node:assert/strict");

/** Disposable S3 wire fixture: real SDK signing, multipart bodies and range reads. */
async function startS3Fixture() {
  const objects = new Map(), multipart = new Map(), calls = [];
  const errors = [];
  const etag = bytes => `"${crypto.createHash("md5").update(bytes).digest("hex")}"`;
  const server = http.createServer(async (req, res) => {
    try {
      const url = new URL(req.url, "http://fixture");
      const key = decodeURIComponent(url.pathname).replace(/^\/fixture-bucket\//, "");
      calls.push({ method: req.method, key, multipart: url.searchParams.has("uploadId") });
      assert.match(req.headers.authorization, /^AWS4-HMAC-SHA256 /);
      const metadata = Object.fromEntries(Object.entries(req.headers).filter(([name]) => name.startsWith("x-amz-meta-")));
      if (req.method === "POST" && url.searchParams.has("uploads")) {
        const id = crypto.randomUUID(); multipart.set(id, { key, metadata, parts: new Map() });
        res.setHeader("Content-Type", "application/xml");
        res.end(`<InitiateMultipartUploadResult><Bucket>fixture-bucket</Bucket><Key>${key}</Key><UploadId>${id}</UploadId></InitiateMultipartUploadResult>`);
        return;
      }
      if (req.method === "PUT") {
        const chunks = []; for await (const chunk of req) chunks.push(chunk);
        const bytes = Buffer.concat(chunks);
        assert.equal(req.headers["content-md5"], crypto.createHash("md5").update(bytes).digest("base64"));
        if (url.searchParams.has("uploadId")) multipart.get(url.searchParams.get("uploadId")).parts.set(Number(url.searchParams.get("partNumber")), bytes);
        else objects.set(key, { bytes, metadata });
        res.setHeader("ETag", etag(bytes)); res.end(); return;
      }
      if (req.method === "POST" && url.searchParams.has("uploadId")) {
        for await (const chunk of req) { /* Consume the SDK's completion XML. */ }
        const upload = multipart.get(url.searchParams.get("uploadId"));
        const bytes = Buffer.concat([...upload.parts].sort((a, b) => a[0] - b[0]).map(entry => entry[1]));
        objects.set(key, { bytes, metadata: upload.metadata }); multipart.delete(url.searchParams.get("uploadId"));
        res.setHeader("Content-Type", "application/xml");
        res.end(`<CompleteMultipartUploadResult><Bucket>fixture-bucket</Bucket><Key>${key}</Key><ETag>${etag(bytes)}</ETag></CompleteMultipartUploadResult>`);
        return;
      }
      // Allow failed multipart cleanup, but reject deletion of completed objects.
      if (req.method === "DELETE" && url.searchParams.has("uploadId")) {
        multipart.delete(url.searchParams.get("uploadId")); res.writeHead(204); res.end(); return;
      }
      if (req.method === "DELETE") throw new Error("Completed OSS objects must never be deleted.");
      const object = objects.get(key);
      if (!object) { res.writeHead(404); res.end(); return; }
      res.setHeader("ETag", etag(object.bytes));
      res.setHeader("Last-Modified", "Thu, 01 Jan 2026 00:00:00 GMT");
      for (const [name, value] of Object.entries(object.metadata)) res.setHeader(name, value);
      const range = req.headers.range?.match(/^bytes=(\d+)-(\d+)$/);
      const bytes = range ? object.bytes.subarray(Number(range[1]), Number(range[2]) + 1) : object.bytes;
      if (range) { res.statusCode = 206; res.setHeader("Content-Range", `bytes ${range[1]}-${range[2]}/${object.bytes.length}`); }
      res.setHeader("Content-Length", bytes.length);
      res.end(req.method === "HEAD" ? undefined : bytes);
    } catch (error) {
      errors.push(error.message); res.writeHead(500); res.end();
    }
  });
  await new Promise((resolve, reject) => { server.once("error", reject); server.listen(0, "127.0.0.1", resolve); });
  return { endpoint: `http://127.0.0.1:${server.address().port}`, objects, calls, errors, multipart,
    async close() { server.closeAllConnections(); await new Promise(resolve => server.close(resolve)); } };
}

module.exports = { startS3Fixture };
