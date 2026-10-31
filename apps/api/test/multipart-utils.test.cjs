const test = require("node:test");
const assert = require("node:assert/strict");
const { createMultipartParser } = require("../src/multipart-utils.cjs");

test("multipart parser preserves UTF-8 filenames", async () => {
  const boundary = "----multipart-utf8-filename-test";
  const expectedFilename = "微信图片_20260812101258_3292_87.jpg";
  const body = Buffer.concat([
    Buffer.from(
      `--${boundary}\r\nContent-Disposition: form-data; name="sdrFiles"; filename="`,
      "ascii"
    ),
    Buffer.from(expectedFilename, "utf8"),
    Buffer.from(
      `"\r\nContent-Type: image/jpeg\r\n\r\ntest\r\n--${boundary}--\r\n`,
      "ascii"
    )
  ]);

  const actualFilename = await new Promise((resolve, reject) => {
    let filename = null;
    const parser = createMultipartParser({
      headers: {
        "content-type": `multipart/form-data; boundary=${boundary}`
      }
    });

    parser.on("file", (_name, stream, info) => {
      filename = info.filename;
      stream.resume();
    });
    parser.on("close", () => resolve(filename));
    parser.on("error", reject);
    parser.end(body);
  });

  assert.equal(actualFilename, expectedFilename);
});
