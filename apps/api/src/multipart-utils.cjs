const Busboy = require("busboy");

function createMultipartParser(options) {
  return Busboy({
    ...options,
    // Browsers encode non-ASCII filenames as UTF-8 in the multipart header,
    // while Busboy otherwise defaults unlabelled filename parameters to latin1.
    defParamCharset: "utf8"
  });
}

module.exports = { createMultipartParser };
