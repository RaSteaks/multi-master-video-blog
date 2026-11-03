const fs = require("node:fs");
const crypto = require("node:crypto");
const fail = (statusCode, message) => Object.assign(new Error(message), { statusCode });

function createOssObjects(config) {
  // Load the multipart SDK only for deployments that opt into OSS.
  const { S3Client, HeadObjectCommand, GetObjectCommand } = require("@aws-sdk/client-s3");
  const { Upload } = require("@aws-sdk/lib-storage");
  const client = new S3Client({ region: config.region, endpoint: config.endpoint,
    credentials: { accessKeyId: config.key, secretAccessKey: config.secret },
    requestChecksumCalculation: "WHEN_REQUIRED", responseChecksumValidation: "WHEN_REQUIRED",
    requestHandler: { connectionTimeout: 10_000, requestTimeout: 120_000 } });
  // lib-storage buffers each bounded part. Content-MD5 lets OSS validate its
  // bytes without relying on multipart ETags or optional AWS checksum extensions.
  client.middlewareStack.add((next, context) => async args => {
    if (["PutObjectCommand", "UploadPartCommand"].includes(context.commandName)) {
      args.input.ContentMD5 = crypto.createHash("md5").update(args.input.Body).digest("base64");
    }
    return next(args);
  }, { step: "initialize", name: "videoOssContentMd5" });
  return {
    async upload({ key, filename, size, sha256, contentType }) {
      const stream = fs.createReadStream(filename);
      try {
        await new Upload({ client, queueSize: 2, partSize: 8 * 1024 ** 2, leavePartsOnError: false,
          params: { Bucket: config.bucket, Key: key, Body: stream, ContentLength: size,
            ContentType: contentType, Metadata: { sha256 } } }).done();
      } finally { stream.destroy(); }
    },
    async write({ key, bytes, sha256, contentType }) {
      await new Upload({ client, queueSize: 2, partSize: 8 * 1024 ** 2, leavePartsOnError: false,
        params: { Bucket: config.bucket, Key: key, Body: bytes, ContentLength: bytes.length,
          ContentType: contentType, Metadata: { sha256 } } }).done();
    },
    async stat(key, signal) {
      try {
        const object = await client.send(new HeadObjectCommand({ Bucket: config.bucket, Key: key }),
          { abortSignal: signal || AbortSignal.timeout(30_000) });
        return { size: object.ContentLength, sha256: object.Metadata?.sha256,
          etag: object.ETag, modified: object.LastModified };
      } catch (error) {
        if (error.$metadata?.httpStatusCode === 404 || error.name === "NotFound") return null;
        throw fail(503, "Object storage is temporarily unavailable.");
      }
    },
    async read(key, range, signal) {
      try {
        const response = await client.send(new GetObjectCommand({ Bucket: config.bucket, Key: key,
          ...(range ? { Range: `bytes=${range.start}-${range.end}` } : {}) }), { abortSignal: signal });
        return response.Body;
      } catch (error) {
        throw fail(error.$metadata?.httpStatusCode === 404 ? 404 : 503, "Object storage is temporarily unavailable.");
      }
    },
    close: () => client.destroy()
  };
}

module.exports = { createOssObjects };
