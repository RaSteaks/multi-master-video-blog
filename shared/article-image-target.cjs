// Drafts use a canonical inline target; the optional quoted title survives URL replacement.
const ARTICLE_IMAGE_PREFIX = "article-image://";
const ARTICLE_IMAGE_TARGET_PATTERN =
  /!\[([^\]\r\n]*)\]\(article-image:\/\/([a-zA-Z0-9][a-zA-Z0-9._-]{0,127})( "[^"\r\n]*")?\)/g;

module.exports = { ARTICLE_IMAGE_PREFIX, ARTICLE_IMAGE_TARGET_PATTERN };
