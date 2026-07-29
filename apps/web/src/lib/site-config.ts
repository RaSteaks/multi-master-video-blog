function envText(name: string, fallback: string) {
  const value = process.env[name]?.trim();
  return value || fallback;
}

function envList(name: string, fallback: string[]) {
  const value = process.env[name]?.trim();
  if (!value) return fallback;

  return value
    .split("|")
    .map((item) => item.trim())
    .filter(Boolean);
}

export const siteConfig = {
  title: envText("SITE_TITLE", "Multi Master Video Blog"),
  description: envText(
    "SITE_DESCRIPTION",
    "Self-hosted media blog with HLS playback and multi-master video switching.",
  ),
  articleTocLabel: envText("SITE_ARTICLE_TOC_LABEL", "目录"),
  home: {
    summary: envText(
      "SITE_HOME_SUMMARY",
      "A cinema-grade media platform for articles, HLS video playback, HDR metadata, and seamless switching between SDR, HDR10, HLG, and Dolby Vision masters.",
    ),
    profileName: envText("SITE_HOME_PROFILE_NAME", "Creator Name"),
    profileRole: envText("SITE_HOME_PROFILE_ROLE", "Image maker / writer / web builder"),
    profileBio: envText(
      "SITE_HOME_PROFILE_BIO",
      "A personal archive for video projects, technical notes, writing, and experiments around web-based media publishing.",
    ),
    profileInitials: envText("SITE_HOME_PROFILE_INITIALS", "MM"),
    avatarUrl: envText("SITE_HOME_AVATAR_URL", ""),
    githubUrl: envText("SITE_GITHUB_URL", "https://github.com/"),
    bilibiliUrl: envText("SITE_BILIBILI_URL", "https://space.bilibili.com/"),
    postUploadHref: envText("SITE_POST_UPLOAD_HREF", "/write"),
    albumUploadHref: envText(
      "SITE_ALBUM_UPLOAD_HREF",
      "/albums?dialog=upload",
    ),
    collectionEyebrow: envText("SITE_HOME_COLLECTION_EYEBROW", "Collection"),
    collectionTitle: envText("SITE_HOME_COLLECTION_TITLE", "Personal Index"),
    collectionSummary: envText(
      "SITE_HOME_COLLECTION_SUMMARY",
      "Blog, posts, albums, and web about are grouped here for quick navigation.",
    ),
    collectionBlogLabel: envText("SITE_HOME_COLLECTION_BLOG_LABEL", "Blog"),
    collectionPostLabel: envText("SITE_HOME_COLLECTION_POST_LABEL", "Post"),
    collectionAlbumLabel: envText(
      "SITE_HOME_COLLECTION_ALBUM_LABEL",
      "Album",
    ),
    collectionAboutLabel: envText("SITE_HOME_COLLECTION_ABOUT_LABEL", "Web About"),
    collectionAboutValue: envText("SITE_HOME_COLLECTION_ABOUT_VALUE", "Info"),
  },
  about: {
    eyebrow: envText("SITE_ABOUT_EYEBROW", "About"),
    title: envText("SITE_ABOUT_TITLE", "About This Site"),
    summary: envText(
      "SITE_ABOUT_SUMMARY",
      "A self-hosted media blog for articles, video projects, HLS playback, and multi-master HDR workflows built for creators who care about image quality.",
    ),
    whatTitle: envText("SITE_ABOUT_WHAT_TITLE", "What This Is"),
    whatBody: envText(
      "SITE_ABOUT_WHAT_BODY",
      "Multi Master Video Blog is a self-hosted platform running on a Windows server. It supports article publishing, HLS adaptive streaming, and comparison of multiple video masters including SDR, HDR10, HLG, and Dolby Vision.",
    ),
    techTitle: envText("SITE_ABOUT_TECH_TITLE", "Tech Stack"),
    techStack: envList("SITE_ABOUT_TECH_STACK", [
      "Next.js + React for the frontend",
      "Directus CMS for content management",
      "Node.js upload API with ffmpeg transcoding",
      "Shaka Player for browser-based HLS playback",
      "Nginx reverse proxy with HTTPS",
    ]),
    contactTitle: envText("SITE_ABOUT_CONTACT_TITLE", "Contact"),
    contactBody: envText(
      "SITE_ABOUT_CONTACT_BODY",
      "This is a personal project. Reach out through the usual channels.",
    ),
  },
};
