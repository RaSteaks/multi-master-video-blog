import { MARKDOWN_EXTENSION } from "./dropped-files";
import { ARTICLE_IMAGE_PREFIX } from "../../../../shared/article-image-target.cjs";

export const MAX_MARKDOWN_BYTES = 2 * 1024 * 1024;
export const MAX_IMAGE_BYTES = 12 * 1024 * 1024;
export const MAX_INLINE_IMAGES = 24;
const imageTypes = new Map([
  ["jpg", "image/jpeg"], ["jpeg", "image/jpeg"], ["png", "image/png"],
  ["webp", "image/webp"], ["gif", "image/gif"], ["avif", "image/avif"],
]);

type ImportedImage = { file: File; key: string; alt: string };
export type MarkdownImport = {
  document: File;
  content: string;
  images: ImportedImage[];
  missing: string[];
};

export function createImageKey() {
  return globalThis.crypto?.randomUUID?.() ??
    `img-${Date.now().toString(36)}-${Math.random().toString(36).slice(2)}`;
}

// Character references preserve literal alt text and titles inside generated Markdown.
export function imageLabel(value: string) {
  return value.replace(/[&\\[\]<>"*_`|~$\r\n]/g, char => `&#${char.charCodeAt(0)};`);
}

function selectedPath(file: File) {
  // webkitRelativePath includes the selected root folder; loose files have only a name.
  const path = file.webkitRelativePath;
  return (path ? path.slice(path.indexOf("/") + 1) : file.name).normalize("NFC");
}

function relativeImagePath(url: string) {
  const path = url.split(/[?#]/, 1)[0].replace(/\\/g, "/");
  if (!path || path.startsWith("/") || /^[a-z][a-z\d+.-]*:/i.test(path)) return null;
  try {
    return decodeURIComponent(path).normalize("NFC");
  } catch {
    return path.normalize("NFC"); // A literal percent sign is valid in a local file name.
  }
}

function resolvePath(directory: string[], path: string) {
  const parts = [...directory];
  for (const part of path.split("/")) {
    if (!part || part === ".") continue;
    if (part === "..") {
      if (!parts.length) return null;
      parts.pop();
    } else parts.push(part);
  }
  return parts.join("/");
}

export async function readMarkdown(files: File[], original?: File): Promise<MarkdownImport> {
  const documents = files.filter(file => original ? file.name === original.name : MARKDOWN_EXTENSION.test(file.name));
  if (!documents.length) throw new Error(original
    ? `请选择包含「${original.name}」及其图片的文件夹。` : "请选择 .md 或 .markdown 文件。");
  if (documents.length !== 1) throw new Error(original
    ? "文件夹中有多份同名文章，请选择范围更小的文件夹。"
    : "一次只能导入一篇 Markdown。文件夹中有多篇时，请先在「导入文件」中单独选择目标文章。");
  const document = original ?? documents[0];
  if (document.size > MAX_MARKDOWN_BYTES) throw new Error("Markdown 文件不能超过 2 MiB。");

  let content: string;
  try {
    const bytes = await document.arrayBuffer();
    content = new TextDecoder("utf-8", { fatal: true }).decode(bytes).replace(/\r\n?/g, "\n");
  } catch {
    throw new Error("Markdown 读取失败，请选择 UTF-8 编码的文本文件。");
  }
  if (content.includes("\0")) throw new Error("请选择 UTF-8 编码的 Markdown 文本文件。");
  if (!content.trim()) throw new Error("Markdown 文件没有正文，请选择其他文件。");
  if (!content.includes("![")) return { document, content, images: [], missing: [] };

  const { markdownImageReferences } = await import("./markdown-image-references");
  const references = markdownImageReferences(content);
  const directory = selectedPath(documents[0]).split("/").slice(0, -1);
  const selected = new Map<string, File | null>();
  for (const file of files) {
    const path = selectedPath(file);
    // A flat drop can contain two identically named files from different directories.
    selected.set(path, selected.has(path) ? null : file);
  }
  const images = new Map<File, ImportedImage>();
  const missing = new Set<string>();
  const parts: string[] = [];
  let offset = 0;
  for (const ref of references) {
    const relative = relativeImagePath(ref.url);
    if (!relative) continue;
    const path = resolvePath(directory, relative);
    const file = path && selected.get(path);
    if (!file) {
      missing.add(ref.url);
      continue;
    }
    let image = images.get(file);
    if (!image) {
      const mime = imageTypes.get(file.name.split(".").pop()?.toLowerCase() ?? "");
      if (!mime || (file.type && file.type !== mime)) throw new Error(`「${file.name}」需要是 JPEG、PNG、WebP、GIF 或 AVIF 图片。`);
      if (file.size > MAX_IMAGE_BYTES) throw new Error(`「${file.name}」超过单张图片 12 MiB 限制。`);
      if (images.size >= MAX_INLINE_IMAGES) throw new Error("每篇文章最多添加 24 张正文图片。");
      image = {
        key: createImageKey(), alt: ref.alt.slice(0, 300),
        file: file.type ? file : new File([file], file.name, { type: mime, lastModified: file.lastModified }),
      };
      images.set(file, image);
    }
    const title = ref.title ? ` "${imageLabel(ref.title)}"` : "";
    parts.push(content.slice(offset, ref.start), `![${imageLabel(ref.alt)}](${ARTICLE_IMAGE_PREFIX}${image.key}${title})`);
    offset = ref.end;
  }
  parts.push(content.slice(offset));
  return { document, content: parts.join(""), images: [...images.values()], missing: [...missing] };
}
