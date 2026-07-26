"use client";

import Link from "next/link";
import {
  memo,
  useDeferredValue,
  useEffect,
  useMemo,
  useRef,
  useState,
  type ChangeEvent,
  type ClipboardEvent as ReactClipboardEvent,
  type DragEvent as ReactDragEvent,
  type FormEvent,
  type KeyboardEvent as ReactKeyboardEvent,
} from "react";
import ReactMarkdown, { defaultUrlTransform, type Components } from "react-markdown";
import remarkGfm from "remark-gfm";
import styles from "./ArticleEditor.module.css";

type SubmitPhase = "idle" | "uploading" | "success" | "error";
type ViewMode = "write" | "split" | "preview";

type PendingImage = {
  key: string;
  file: File;
  alt: string;
  previewUrl: string;
};

type CoverAsset = {
  file: File;
  previewUrl: string;
  persistedId?: string;
};

type ArticleResult = {
  id: string | number;
  slug: string;
  published: boolean;
  url?: string;
};

type ArticleResponse = {
  status?: string;
  article?: ArticleResult & {
    coverImage?: { id: string; url: string } | null;
  };
  uploadedImages?: Array<{ key?: string; id?: string; url?: string }>;
  error?: string;
  message?: string;
};

type SelectionRange = { start: number; end: number };

const MAX_IMAGE_BYTES = 12 * 1024 * 1024;
const MAX_ARTICLE_UPLOAD_BYTES = 64 * 1024 * 1024;
const MAX_MARKDOWN_BYTES = 2 * 1024 * 1024;
const MAX_INLINE_IMAGES = 24;
const MAX_TAG_LENGTH = 64;
const SLUG_PATTERN = /^[a-z0-9]+(?:-[a-z0-9]+)*$/;
const ARTICLE_IMAGE_PREFIX = "article-image://";
const ARTICLE_IMAGE_MARKDOWN_PATTERN =
  /!\[[^\]\r\n]*\]\(article-image:\/\/([a-zA-Z0-9_-]+)\)/g;

function slugify(value: string) {
  return value
    .normalize("NFKD")
    .replace(/[\u0300-\u036f]/g, "")
    .toLowerCase()
    .replace(/[^a-z0-9]+/g, "-")
    .replace(/^-+|-+$/g, "")
    .replace(/-+/g, "-");
}

function timestampSlug() {
  const stamp = new Date().toISOString().slice(0, 16).replace(/[-T:]/g, "");
  return `article-${stamp}`;
}

function normalizeTags(values: string[]) {
  const seen = new Set<string>();
  const result: string[] = [];
  for (const value of values.flatMap((item) => item.split(/[,，]/))) {
    const tag = value.trim().replace(/^#+/, "").slice(0, MAX_TAG_LENGTH);
    const key = tag.toLocaleLowerCase();
    if (!tag || seen.has(key)) continue;
    seen.add(key);
    result.push(tag);
  }
  return result.slice(0, 12);
}

function imageKeysIn(markdown: string) {
  const keys = new Set<string>();
  const pattern = new RegExp(ARTICLE_IMAGE_MARKDOWN_PATTERN.source, "g");
  let match: RegExpExecArray | null;
  while ((match = pattern.exec(markdown))) keys.add(match[1]);
  return keys;
}

function countWords(value: string) {
  const han = value.match(/[\p{Script=Han}]/gu)?.length ?? 0;
  const words = value
    .replace(/[\p{Script=Han}]/gu, " ")
    .match(/[\p{Letter}\p{Number}]+(?:['’-][\p{Letter}\p{Number}]+)*/gu)?.length ?? 0;
  return han + words;
}

function cleanAlt(value: string) {
  return value.replace(/[\]\r\n]/g, " ").replace(/\s+/g, " ").trim().slice(0, 300);
}

function altFromFile(file: File) {
  return cleanAlt(file.name.replace(/\.[^.]+$/, "")) || "文章插图";
}

function escapeRegExp(value: string) {
  return value.replace(/[.*+?^${}()|[\]\\]/g, "\\$&");
}

function createImageKey() {
  return globalThis.crypto?.randomUUID?.() ??
    `img-${Date.now().toString(36)}-${Math.random().toString(36).slice(2)}`;
}

function fileIdentity(file: File | undefined) {
  return file ? `${file.name}:${file.size}:${file.lastModified}` : "";
}

function editorFingerprint(input: {
  title: string;
  slug: string;
  category: string;
  tags: string[];
  tagInput: string;
  content: string;
  cover?: File;
  images: PendingImage[];
}) {
  return JSON.stringify({
    ...input,
    cover: fileIdentity(input.cover),
    images: input.images.map((image) => ({
      key: image.key,
      alt: image.alt,
      file: fileIdentity(image.file),
    })),
  });
}

function isSafeLink(value: string) {
  const url = value.trim();
  return /^(https?:\/\/|mailto:|\/|#)/i.test(url) && !/^\/\//.test(url);
}

function previewUrlTransform(url: string) {
  if (url.startsWith(ARTICLE_IMAGE_PREFIX)) return url;
  return defaultUrlTransform(url);
}

function persistUploadedImageUrls(
  markdown: string,
  uploadedImages: NonNullable<ArticleResponse["uploadedImages"]>,
) {
  const urls = new Map(
    uploadedImages.flatMap((image) =>
      image.key && image.url ? [[image.key, image.url] as const] : [],
    ),
  );

  return markdown.replace(
    new RegExp(ARTICLE_IMAGE_MARKDOWN_PATTERN.source, "g"),
    (imageMarkdown, key: string) => {
      const url = urls.get(key);
      return url
        ? imageMarkdown.replace(`${ARTICLE_IMAGE_PREFIX}${key}`, url)
        : imageMarkdown;
    },
  );
}

const ArticlePreview = memo(function ArticlePreview({
  content,
  images,
}: {
  content: string;
  images: PendingImage[];
}) {
  const imageMap = useMemo(
    () => new Map(images.map((image) => [image.key, image])),
    [images],
  );
  const components = useMemo<Components>(
    () => ({
      img: ({ src, alt, node: _node, ...props }) => {
        const source = typeof src === "string" ? src : undefined;
        const key = source?.startsWith(ARTICLE_IMAGE_PREFIX)
          ? source.slice(ARTICLE_IMAGE_PREFIX.length)
          : null;
        const localImage = key ? imageMap.get(key) : null;

        if (key && !localImage) {
          return (
            <span className={styles.missingImage} role="note">
              图片附件尚未选择：{alt || key}
            </span>
          );
        }

        return (
          <span className={styles.previewImage}>
            {/* Blob URLs are local editor previews and are never persisted. */}
            <img {...props} src={localImage?.previewUrl ?? source} alt={alt ?? ""} />
            {alt ? <span>{alt}</span> : null}
          </span>
        );
      },
      a: ({ href, children, node: _node, ...props }) => {
        const external = Boolean(href?.startsWith("http"));
        return (
          <a
            {...props}
            href={href}
            target={external ? "_blank" : undefined}
            rel={external ? "noreferrer" : undefined}
          >
            {children}
          </a>
        );
      },
    }),
    [imageMap],
  );

  if (!content.trim()) {
    return (
      <div className={styles.previewEmpty}>
        <span aria-hidden="true">Aa</span>
        <strong>预览区等待内容</strong>
        <p>从左侧开始写作，这里会呈现最终的 Markdown 排版。</p>
      </div>
    );
  }

  return (
    <article className={styles.previewBody}>
      <ReactMarkdown
        components={components}
        remarkPlugins={[remarkGfm]}
        urlTransform={previewUrlTransform}
      >
        {content}
      </ReactMarkdown>
    </article>
  );
});

function ToolbarButton({
  label,
  mark,
  shortcut,
  onClick,
}: {
  label: string;
  mark: string;
  shortcut?: string;
  onClick: () => void;
}) {
  return (
    <button
      className={styles.toolButton}
      type="button"
      onClick={onClick}
      aria-label={shortcut ? `${label}（${shortcut}）` : label}
      title={shortcut ? `${label} · ${shortcut}` : label}
    >
      {mark}
    </button>
  );
}

export function ArticleEditor() {
  const [token, setToken] = useState("");
  const [showToken, setShowToken] = useState(false);
  const [title, setTitle] = useState("");
  const [slug, setSlug] = useState("");
  const [slugTouched, setSlugTouched] = useState(false);
  const [category, setCategory] = useState("");
  const [tags, setTags] = useState<string[]>([]);
  const [tagInput, setTagInput] = useState("");
  const [content, setContent] = useState("");
  const [cover, setCover] = useState<CoverAsset | null>(null);
  const [removeCoverRequested, setRemoveCoverRequested] = useState(false);
  const [images, setImages] = useState<PendingImage[]>([]);
  const [coverDragging, setCoverDragging] = useState(false);
  const [viewMode, setViewMode] = useState<ViewMode>("split");
  const [linkOpen, setLinkOpen] = useState(false);
  const [linkText, setLinkText] = useState("");
  const [linkUrl, setLinkUrl] = useState("");
  const [linkError, setLinkError] = useState("");
  const [phase, setPhase] = useState<SubmitPhase>("idle");
  const [message, setMessage] = useState("尚未保存");
  const [progress, setProgress] = useState(0);
  const [attemptedAction, setAttemptedAction] = useState<"draft" | "publish" | null>(null);
  const [lastArticle, setLastArticle] = useState<ArticleResult | null>(null);
  const attempted = attemptedAction !== null;
  const isUploading = phase === "uploading";

  const tokenRef = useRef<HTMLInputElement>(null);
  const titleRef = useRef<HTMLInputElement>(null);
  const slugRef = useRef<HTMLInputElement>(null);
  const textareaRef = useRef<HTMLTextAreaElement>(null);
  const coverInputRef = useRef<HTMLInputElement>(null);
  const imageInputRef = useRef<HTMLInputElement>(null);
  const imageRangeRef = useRef<SelectionRange>({ start: 0, end: 0 });
  const linkRangeRef = useRef<SelectionRange>({ start: 0, end: 0 });
  const objectUrlsRef = useRef(new Set<string>());
  const xhrRef = useRef<XMLHttpRequest | null>(null);

  const effectiveTags = useMemo(
    () => normalizeTags([...tags, tagInput]),
    [tagInput, tags],
  );
  const referencedKeys = useMemo(() => imageKeysIn(content), [content]);
  const missingImageKeys = useMemo(() => {
    const available = new Set(images.map((image) => image.key));
    return [...referencedKeys].filter((key) => !available.has(key));
  }, [images, referencedKeys]);
  const deferredContent = useDeferredValue(content);
  const wordCount = useMemo(() => countWords(content), [content]);
  const contentBytes = useMemo(
    () => new TextEncoder().encode(content).byteLength,
    [content],
  );
  const referencedImages = useMemo(
    () => images.filter((image) => referencedKeys.has(image.key)),
    [images, referencedKeys],
  );
  const uploadBytes = useMemo(
    () =>
      contentBytes +
      (cover && !cover.persistedId ? cover.file.size : 0) +
      referencedImages.reduce((total, image) => total + image.file.size, 0),
    [contentBytes, cover, referencedImages],
  );

  const currentFingerprint = useMemo(
    () =>
      editorFingerprint({
        title,
        slug,
        category,
        tags,
        tagInput,
        content,
        cover: cover?.file,
        images,
      }),
    [category, content, cover, images, slug, tagInput, tags, title],
  );
  const latestFingerprintRef = useRef(currentFingerprint);
  latestFingerprintRef.current = currentFingerprint;
  const [savedFingerprint, setSavedFingerprint] = useState(() =>
    editorFingerprint({
      title: "",
      slug: "",
      category: "",
      tags: [],
      tagInput: "",
      content: "",
      images: [],
    }),
  );
  const isDirty = currentFingerprint !== savedFingerprint;

  const commonValidationErrors = useMemo(() => {
    const errors: string[] = [];
    if (!token.trim()) errors.push("请输入文章访问令牌");
    if (!title.trim()) errors.push("请输入文章标题");
    if (!slug.trim()) errors.push("请输入 URL 标识");
    else if (!SLUG_PATTERN.test(slug.trim()))
      errors.push("URL 标识只能包含小写字母、数字与单个连字符");
    if (contentBytes > MAX_MARKDOWN_BYTES) errors.push("Markdown 正文超过 2 MB 限制");
    if (uploadBytes > MAX_ARTICLE_UPLOAD_BYTES)
      errors.push("文章、封面与正文图片合计超过 64 MB 限制");
    if (missingImageKeys.length > 0)
      errors.push(`正文中有 ${missingImageKeys.length} 张图片缺少本地附件`);
    return errors;
  }, [contentBytes, missingImageKeys.length, slug, title, token, uploadBytes]);

  const publishValidationErrors = useMemo(
    () =>
      content.trim()
        ? commonValidationErrors
        : [...commonValidationErrors, "发布前请填写 Markdown 正文"],
    [commonValidationErrors, content],
  );

  useEffect(() => {
    return () => {
      for (const url of objectUrlsRef.current) URL.revokeObjectURL(url);
      const request = xhrRef.current;
      if (request) {
        request.onload = null;
        request.onerror = null;
        request.onabort = null;
        request.abort();
      }
    };
  }, []);

  useEffect(() => {
    if (!isDirty) return;

    const warnBeforeUnload = (event: BeforeUnloadEvent) => {
      event.preventDefault();
      event.returnValue = "";
    };
    const confirmLinkNavigation = (event: MouseEvent) => {
      if (event.defaultPrevented || event.button !== 0 || event.metaKey || event.ctrlKey)
        return;
      const element = event.target instanceof Element ? event.target : null;
      const anchor = element?.closest<HTMLAnchorElement>("a[href]");
      if (!anchor || anchor.target === "_blank" || anchor.hasAttribute("download")) return;
      const destination = new URL(anchor.href, window.location.href);
      const current = new URL(window.location.href);
      if (
        destination.origin === current.origin &&
        destination.pathname === current.pathname &&
        destination.search === current.search
      )
        return;
      if (window.confirm("文章还有未保存的更改，确定离开此页面吗？")) return;
      event.preventDefault();
      event.stopPropagation();
    };

    window.addEventListener("beforeunload", warnBeforeUnload);
    document.addEventListener("click", confirmLinkNavigation, true);
    return () => {
      window.removeEventListener("beforeunload", warnBeforeUnload);
      document.removeEventListener("click", confirmLinkNavigation, true);
    };
  }, [isDirty]);

  useEffect(() => {
    if (phase === "success" && isDirty) {
      setPhase("idle");
      setMessage("已保存版本之后还有新的未保存更改");
    }
  }, [isDirty, phase]);

  function makePreviewUrl(file: File) {
    const url = URL.createObjectURL(file);
    objectUrlsRef.current.add(url);
    return url;
  }

  function releasePreviewUrl(url: string) {
    URL.revokeObjectURL(url);
    objectUrlsRef.current.delete(url);
  }

  function validateImage(file: File) {
    if (!file.type.startsWith("image/") || file.type === "image/svg+xml")
      return `${file.name} 不是支持的位图格式`;
    if (file.size > MAX_IMAGE_BYTES)
      return `${file.name} 超过 12 MB 限制`;
    return null;
  }

  function handleTitle(value: string) {
    setTitle(value);
    if (!slugTouched) setSlug(slugify(value));
  }

  function regenerateSlug() {
    setSlug(slugify(title) || timestampSlug());
    setSlugTouched(true);
    requestAnimationFrame(() => slugRef.current?.focus());
  }

  function commitTag(value = tagInput) {
    const next = normalizeTags([...tags, value]);
    setTags(next);
    setTagInput("");
  }

  function handleTagKeyDown(event: ReactKeyboardEvent<HTMLInputElement>) {
    if (event.key === "Enter" || event.key === "," || event.key === "，") {
      event.preventDefault();
      commitTag();
      return;
    }
    if (event.key === "Backspace" && !tagInput && tags.length > 0)
      setTags((current) => current.slice(0, -1));
  }

  function removeTag(index: number) {
    setTags((current) => current.filter((_, itemIndex) => itemIndex !== index));
  }

  function setCoverFile(file: File | undefined) {
    if (!file || isUploading) return;
    const error = validateImage(file);
    if (error) {
      setPhase("error");
      setMessage(error);
      return;
    }
    if (cover) releasePreviewUrl(cover.previewUrl);
    setCover({ file, previewUrl: makePreviewUrl(file) });
    setRemoveCoverRequested(false);
    setPhase("idle");
    setMessage("封面已选择，保存文章时会一并上传");
  }

  function removeCover() {
    if (isUploading) return;
    setRemoveCoverRequested(Boolean(cover?.persistedId));
    if (cover) releasePreviewUrl(cover.previewUrl);
    setCover(null);
    if (coverInputRef.current) coverInputRef.current.value = "";
  }

  function handleCoverDrop(event: ReactDragEvent<HTMLDivElement>) {
    event.preventDefault();
    setCoverDragging(false);
    if (isUploading) return;
    setCoverFile(event.dataTransfer.files[0]);
  }

  function selection(): SelectionRange {
    const field = textareaRef.current;
    const end = field?.selectionEnd ?? content.length;
    return { start: field?.selectionStart ?? end, end };
  }

  function replaceRange(
    range: SelectionRange,
    replacement: string,
    selectionStart: number,
    selectionEnd = selectionStart,
  ) {
    const source = textareaRef.current?.value ?? content;
    const start = Math.max(0, Math.min(range.start, source.length));
    const end = Math.max(start, Math.min(range.end, source.length));
    setContent(source.slice(0, start) + replacement + source.slice(end));
    requestAnimationFrame(() => {
      textareaRef.current?.focus();
      textareaRef.current?.setSelectionRange(selectionStart, selectionEnd);
    });
  }

  function wrapSelection(before: string, after: string, placeholder: string) {
    const range = selection();
    const source = textareaRef.current?.value ?? content;
    const selected = source.slice(range.start, range.end) || placeholder;
    const replacement = `${before}${selected}${after}`;
    const innerStart = range.start + before.length;
    replaceRange(range, replacement, innerStart, innerStart + selected.length);
  }

  function prefixLines(prefix: string) {
    const source = textareaRef.current?.value ?? content;
    const range = selection();
    const lineStart = source.lastIndexOf("\n", Math.max(0, range.start - 1)) + 1;
    const nextBreak = source.indexOf("\n", range.end);
    const lineEnd = nextBreak === -1 ? source.length : nextBreak;
    const selected = source.slice(lineStart, lineEnd);
    const replacement = selected
      .split("\n")
      .map((line) => `${prefix}${line}`)
      .join("\n");
    replaceRange(
      { start: lineStart, end: lineEnd },
      replacement,
      lineStart,
      lineStart + replacement.length,
    );
  }

  function openLinkEditor() {
    const range = selection();
    const source = textareaRef.current?.value ?? content;
    linkRangeRef.current = range;
    setLinkText(source.slice(range.start, range.end));
    setLinkUrl("");
    setLinkError("");
    setLinkOpen(true);
  }

  function insertLink() {
    if (!isSafeLink(linkUrl)) {
      setLinkError("请输入 http(s)、mailto、站内 / 路径或 # 锚点链接");
      return;
    }
    const label = cleanAlt(linkText) || linkUrl.trim();
    const replacement = `[${label}](${linkUrl.trim()})`;
    replaceRange(
      linkRangeRef.current,
      replacement,
      linkRangeRef.current.start + replacement.length,
    );
    setLinkOpen(false);
  }

  function closeLinkEditor() {
    setLinkOpen(false);
    requestAnimationFrame(() => textareaRef.current?.focus());
  }

  function queueInlineImages(fileList: FileList | File[], at = selection()) {
    const files = Array.from(fileList);
    const accepted: PendingImage[] = [];
    const errors: string[] = [];
    const remainingSlots = MAX_INLINE_IMAGES - images.length;
    const source = textareaRef.current?.value ?? content;
    const selectedAlt = cleanAlt(source.slice(at.start, at.end));

    for (const file of files) {
      if (accepted.length >= remainingSlots) {
        errors.push(`每篇文章最多添加 ${MAX_INLINE_IMAGES} 张正文图片`);
        break;
      }
      const error = validateImage(file);
      if (error) {
        errors.push(error);
        continue;
      }
      accepted.push({
        key: createImageKey(),
        file,
        alt: accepted.length === 0 && selectedAlt ? selectedAlt : altFromFile(file),
        previewUrl: makePreviewUrl(file),
      });
    }
    if (accepted.length === 0) {
      if (errors.length) {
        setPhase("error");
        setMessage(errors[0]);
      }
      return;
    }

    const markdown = accepted
      .map((image) => `![${image.alt}](${ARTICLE_IMAGE_PREFIX}${image.key})`)
      .join("\n\n");
    const leading = at.start > 0 && source[at.start - 1] !== "\n" ? "\n\n" : "";
    const trailing = at.end < source.length && source[at.end] !== "\n" ? "\n\n" : "";
    const insertion = `${leading}${markdown}${trailing}`;
    setImages((current) => [...current, ...accepted]);
    replaceRange(at, insertion, at.start + insertion.length);
    setPhase(errors.length ? "error" : "idle");
    setMessage(
      errors.length
        ? `已插入 ${accepted.length} 张图片；${errors[0]}`
        : `已插入 ${accepted.length} 张图片，保存时会与文章统一上传`,
    );
  }

  function openImagePicker() {
    imageRangeRef.current = selection();
    imageInputRef.current?.click();
  }

  function handleImageInput(event: ChangeEvent<HTMLInputElement>) {
    if (event.target.files?.length)
      queueInlineImages(event.target.files, imageRangeRef.current);
    event.target.value = "";
  }

  function handleEditorPaste(event: ReactClipboardEvent<HTMLTextAreaElement>) {
    const files = Array.from(event.clipboardData.files).filter((file) =>
      file.type.startsWith("image/"),
    );
    if (!files.length) return;
    event.preventDefault();
    queueInlineImages(files, {
      start: event.currentTarget.selectionStart,
      end: event.currentTarget.selectionEnd,
    });
  }

  function handleEditorDrop(event: ReactDragEvent<HTMLTextAreaElement>) {
    const files = Array.from(event.dataTransfer.files).filter((file) =>
      file.type.startsWith("image/"),
    );
    if (!files.length) return;
    event.preventDefault();
    queueInlineImages(files, {
      start: event.currentTarget.selectionStart,
      end: event.currentTarget.selectionEnd,
    });
  }

  function updateImageAlt(key: string, value: string) {
    const alt = cleanAlt(value);
    setImages((current) =>
      current.map((image) => (image.key === key ? { ...image, alt } : image)),
    );
    const url = `${ARTICLE_IMAGE_PREFIX}${key}`;
    const pattern = new RegExp(`!\\[[^\\]]*\\]\\(${escapeRegExp(url)}\\)`, "g");
    setContent((current) => current.replace(pattern, `![${alt}](${url})`));
  }

  function removeInlineImage(key: string) {
    const image = images.find((item) => item.key === key);
    if (image) releasePreviewUrl(image.previewUrl);
    setImages((current) => current.filter((item) => item.key !== key));
    const url = `${ARTICLE_IMAGE_PREFIX}${key}`;
    const pattern = new RegExp(`!\\[[^\\]]*\\]\\(${escapeRegExp(url)}\\)`, "g");
    setContent((current) => current.replace(pattern, "").replace(/\n{3,}/g, "\n\n"));
  }

  function reinsertInlineImage(image: PendingImage) {
    const range = selection();
    const markdown = `![${image.alt}](${ARTICLE_IMAGE_PREFIX}${image.key})`;
    replaceRange(range, markdown, range.start + markdown.length);
  }

  function handleEditorKeyDown(event: ReactKeyboardEvent<HTMLTextAreaElement>) {
    const modifier = event.metaKey || event.ctrlKey;
    if (modifier && event.key.toLowerCase() === "b") {
      event.preventDefault();
      wrapSelection("**", "**", "粗体文本");
    } else if (modifier && event.key.toLowerCase() === "i") {
      event.preventDefault();
      wrapSelection("*", "*", "斜体文本");
    } else if (modifier && event.key.toLowerCase() === "k") {
      event.preventDefault();
      openLinkEditor();
    } else if (event.key === "Tab") {
      event.preventDefault();
      const range = selection();
      replaceRange(range, "  ", range.start + 2);
    }
  }

  function focusFirstError(published: boolean) {
    if (!token.trim()) tokenRef.current?.focus();
    else if (!title.trim()) titleRef.current?.focus();
    else if (!slug.trim() || !SLUG_PATTERN.test(slug.trim())) slugRef.current?.focus();
    else if (published || missingImageKeys.length > 0) textareaRef.current?.focus();
  }

  function submitArticle(published: boolean) {
    if (phase === "uploading") return;
    const validationErrors = published
      ? publishValidationErrors
      : commonValidationErrors;
    setAttemptedAction(published ? "publish" : "draft");
    if (validationErrors.length > 0) {
      setPhase("error");
      setMessage(validationErrors[0]);
      focusFirstError(published);
      return;
    }

    const submitted = {
      articleId: lastArticle?.id,
      title: title.trim(),
      slug: slug.trim(),
      category: category.trim(),
      tags: effectiveTags,
      content,
      cover,
      removeCover: removeCoverRequested,
      images: referencedImages,
    };
    const manifest = submitted.images.map((image) => ({
      key: image.key,
      name: image.file.name,
      alt: image.alt,
    }));
    const form = new FormData();
    if (submitted.articleId !== undefined)
      form.append("articleId", String(submitted.articleId));
    form.append("title", submitted.title);
    form.append("slug", submitted.slug);
    form.append("content", submitted.content);
    form.append("category", submitted.category);
    form.append("tags", JSON.stringify(submitted.tags));
    form.append("published", String(published));
    form.append("removeCover", String(submitted.removeCover));
    if (submitted.cover && !submitted.cover.persistedId)
      form.append("cover", submitted.cover.file, submitted.cover.file.name);
    for (const image of submitted.images)
      form.append("inlineImages", image.file, image.file.name);
    form.append("inlineImageManifest", JSON.stringify(manifest));

    const submittedFingerprint = currentFingerprint;
    const request = new XMLHttpRequest();
    xhrRef.current = request;
    request.open("POST", "/api/articles");
    request.setRequestHeader("X-Article-Token", token.trim());
    request.setRequestHeader("Accept", "application/json");
    setCoverDragging(false);
    setPhase("uploading");
    setProgress(0);
    setMessage(
      submitted.articleId
        ? published
          ? "正在更新并发布文章…"
          : "正在更新草稿…"
        : published
          ? "正在上传并发布文章…"
          : "正在上传并保存草稿…",
    );

    request.upload.onprogress = (event) => {
      if (event.lengthComputable)
        setProgress(Math.round((event.loaded / event.total) * 100));
    };
    request.onload = () => {
      let payload: ArticleResponse = {};
      try {
        payload = request.responseText ? JSON.parse(request.responseText) : {};
      } catch {
        payload = {};
      }
      const responseArticle = payload.article;
      const validSuccess =
        request.status >= 200 &&
        request.status < 300 &&
        payload.status === "ok" &&
        responseArticle?.id !== undefined &&
        Boolean(responseArticle.slug);

      if (validSuccess && responseArticle) {
        const uploadedImages = payload.uploadedImages ?? [];
        const uploadedUrls = new Map(
          uploadedImages.flatMap((image) =>
            image.key && image.url ? [[image.key, image.url] as const] : [],
          ),
        );
        const missingUploads = submitted.images.filter(
          (image) => !uploadedUrls.has(image.key),
        );
        if (missingUploads.length > 0) {
          setPhase("error");
          setMessage("服务端未返回完整的正文图片结果，请检查文章库后再操作。");
          return;
        }

        const persistedContent = persistUploadedImageUrls(
          submitted.content,
          uploadedImages,
        );
        const uploadedKeys = new Set(submitted.images.map((image) => image.key));
        const responseCover = responseArticle.coverImage;
        const persistedCover =
          submitted.cover && responseCover?.id
            ? { ...submitted.cover, persistedId: responseCover.id }
            : null;
        const noEditsSinceSubmit =
          latestFingerprintRef.current === submittedFingerprint;
        const persistedFingerprint = editorFingerprint({
          title: submitted.title,
          slug: submitted.slug,
          category: submitted.category,
          tags: submitted.tags,
          tagInput: "",
          content: persistedContent,
          cover: persistedCover?.file,
          images: [],
        });

        for (const image of submitted.images) releasePreviewUrl(image.previewUrl);
        setContent((current) => persistUploadedImageUrls(current, uploadedImages));
        setImages((current) => current.filter((image) => !uploadedKeys.has(image.key)));
        setCover((current) =>
          current === submitted.cover ? persistedCover : current,
        );
        if (noEditsSinceSubmit) {
          setTags(submitted.tags);
          setTagInput("");
        }
        setRemoveCoverRequested(false);
        setPhase("success");
        setProgress(100);
        setSavedFingerprint(persistedFingerprint);
        setLastArticle(responseArticle);
        setAttemptedAction(null);
        setMessage(
          responseArticle.published
            ? "文章已上传并发布，Directus 已完成资源处理。"
            : "草稿已上传，Directus 已完成资源处理。",
        );
        return;
      }
      if (request.status >= 200 && request.status < 300) {
        setPhase("error");
        setMessage("服务端返回了不完整的成功响应，请检查文章库后再重试。");
        return;
      }
      setPhase("error");
      setMessage(payload.error || payload.message || `保存失败（HTTP ${request.status}）`);
    };
    request.onerror = () => {
      setPhase("error");
      setMessage("网络连接失败；服务端可能仍在处理，请先检查文章库再重试。");
    };
    request.onabort = () => {
      setPhase("error");
      setMessage("请求已取消；若上传已完成，服务端可能仍在处理，请先检查文章库再重试。");
    };
    request.onloadend = () => {
      if (xhrRef.current === request) xhrRef.current = null;
    };
    request.send(form);
  }

  function cancelUpload() {
    xhrRef.current?.abort();
  }

  function handleFormKeyDown(event: ReactKeyboardEvent<HTMLFormElement>) {
    if (event.defaultPrevented) return;
    if (!(event.metaKey || event.ctrlKey)) {
      if (event.key === "Enter" && event.target instanceof HTMLInputElement)
        event.preventDefault();
      return;
    }
    if (event.key.toLowerCase() === "s") {
      event.preventDefault();
      submitArticle(lastArticle?.published ?? false);
    } else if (event.key === "Enter") {
      event.preventDefault();
      submitArticle(true);
    }
  }

  function handleSubmit(event: FormEvent<HTMLFormElement>) {
    event.preventDefault();
    const submitter = (event.nativeEvent as SubmitEvent).submitter;
    if (!submitter) return;
    submitArticle(true);
  }

  return (
    <main className={styles.page}>
      <form
        className={styles.form}
        onSubmit={handleSubmit}
        onKeyDown={handleFormKeyDown}
        noValidate
        aria-busy={phase === "uploading"}
      >
        <header className={styles.hero}>
          <div>
            <p className={styles.eyebrow}>Editorial desk · 写文章</p>
            <h1>把想法写成一篇文章</h1>
            <p className={styles.heroSummary}>
              在这里完成 Markdown、封面与正文图片；保存后由 Directus 统一处理资源和文章记录。
            </p>
          </div>
          <div className={styles.heroActions}>
            <span className={styles.dirtyBadge} data-dirty={isDirty}>
              <span aria-hidden="true" />
              {isDirty ? "有未保存更改" : lastArticle ? "内容已保存" : "尚未开始"}
            </span>
            <Link href="/posts" className={styles.libraryLink}>
              查看文章库 <span aria-hidden="true">↗</span>
            </Link>
          </div>
        </header>

        <div className={styles.setupGrid}>
          <section className={styles.panel} aria-labelledby="article-details-title">
            <div className={styles.panelHeading}>
              <div>
                <p>01 / Article</p>
                <h2 id="article-details-title">文章信息</h2>
              </div>
              <span>必填项标有 *</span>
            </div>

            <div className={styles.fieldStack}>
              <label className={styles.field} htmlFor="article-title">
                <span>标题 *</span>
                <input
                  ref={titleRef}
                  id="article-title"
                  value={title}
                  onChange={(event) => handleTitle(event.target.value)}
                  maxLength={200}
                  placeholder="一篇值得读完的文章，从好标题开始"
                  autoComplete="off"
                  aria-invalid={attempted && !title.trim()}
                />
                {attempted && !title.trim() ? (
                  <small className={styles.fieldError}>请输入文章标题</small>
                ) : null}
              </label>

              <div className={styles.twoFields}>
                <label className={styles.field} htmlFor="article-slug">
                  <span>URL 标识 *</span>
                  <div className={styles.inputAction}>
                    <input
                      ref={slugRef}
                      id="article-slug"
                      value={slug}
                      onChange={(event) => {
                        setSlug(event.target.value.toLowerCase());
                        setSlugTouched(true);
                      }}
                      placeholder="my-article-title"
                      maxLength={200}
                      autoCapitalize="none"
                      spellCheck={false}
                      aria-invalid={
                        attempted && (!slug.trim() || !SLUG_PATTERN.test(slug.trim()))
                      }
                    />
                    <button type="button" onClick={regenerateSlug}>
                      生成
                    </button>
                  </div>
                  <small
                    className={
                      attempted && (!slug.trim() || !SLUG_PATTERN.test(slug.trim()))
                        ? styles.fieldError
                        : styles.fieldHint
                    }
                  >
                    小写字母、数字与连字符
                  </small>
                </label>

                <label className={styles.field} htmlFor="article-category">
                  <span>分类</span>
                  <input
                    id="article-category"
                    value={category}
                    onChange={(event) => setCategory(event.target.value)}
                    maxLength={100}
                    placeholder="技术 / 随笔 / 影像"
                  />
                </label>
              </div>

              <div className={styles.field}>
                <label htmlFor="article-tags">标签</label>
                <div className={styles.tagEditor}>
                  {tags.map((tag, index) => (
                    <span className={styles.tag} key={`${tag}-${index}`}>
                      {tag}
                      <button
                        type="button"
                        onClick={() => removeTag(index)}
                        aria-label={`移除标签 ${tag}`}
                      >
                        ×
                      </button>
                    </span>
                  ))}
                  <input
                    id="article-tags"
                    value={tagInput}
                    onChange={(event) => setTagInput(event.target.value)}
                    maxLength={MAX_TAG_LENGTH}
                    onKeyDown={handleTagKeyDown}
                    onBlur={() => tagInput.trim() && commitTag()}
                    placeholder={tags.length ? "继续添加" : "输入后按 Enter 添加"}
                  />
                </div>
                <small className={styles.fieldHint}>最多 12 个；支持逗号分隔</small>
              </div>
            </div>
          </section>

          <aside className={`${styles.panel} ${styles.assetsPanel}`}>
            <div className={styles.panelHeading}>
              <div>
                <p>02 / Assets</p>
                <h2>访问与封面</h2>
              </div>
            </div>

            <label className={styles.field} htmlFor="article-token">
              <span>文章访问令牌 *</span>
              <div className={styles.inputAction}>
                <input
                  ref={tokenRef}
                  id="article-token"
                  type={showToken ? "text" : "password"}
                  value={token}
                  onChange={(event) => setToken(event.target.value)}
                  placeholder="ARTICLE_API_TOKEN"
                  autoComplete="off"
                  aria-invalid={attempted && !token.trim()}
                />
                <button type="button" onClick={() => setShowToken((value) => !value)}>
                  {showToken ? "隐藏" : "显示"}
                </button>
              </div>
              <small className={styles.fieldHint}>仅随本次请求发送，不写入文章内容</small>
            </label>

            <div className={styles.field}>
              <span>封面图片</span>
              <input
                ref={coverInputRef}
                className={styles.visuallyHidden}
                type="file"
                disabled={isUploading}
                accept="image/jpeg,image/png,image/webp,image/gif,image/avif"
                onChange={(event) => {
                  setCoverFile(event.target.files?.[0]);
                  event.currentTarget.value = "";
                }}
                tabIndex={-1}
              />
              <div
                className={styles.coverDrop}
                data-dragging={coverDragging}
                data-has-cover={Boolean(cover)}
                onDragEnter={(event) => {
                  event.preventDefault();
                  if (!isUploading) setCoverDragging(true);
                }}
                onDragOver={(event) => event.preventDefault()}
                onDragLeave={() => setCoverDragging(false)}
                onDrop={handleCoverDrop}
              >
                {cover ? (
                  <>
                    <img src={cover.previewUrl} alt="所选文章封面预览" />
                    <div className={styles.coverOverlay}>
                      <strong>{cover.file.name}</strong>
                      <span>{(cover.file.size / 1024 / 1024).toFixed(1)} MB</span>
                      <div>
                        <button type="button" disabled={isUploading} onClick={() => coverInputRef.current?.click()}>
                          替换
                        </button>
                        <button type="button" disabled={isUploading} onClick={removeCover}>
                          移除
                        </button>
                      </div>
                    </div>
                  </>
                ) : (
                  <button type="button" disabled={isUploading} onClick={() => coverInputRef.current?.click()}>
                    <span className={styles.coverMark} aria-hidden="true">＋</span>
                    <strong>{coverDragging ? "松开以选择封面" : "选择或拖入封面"}</strong>
                    <small>JPG、PNG、WebP、GIF、AVIF · 最大 12 MB</small>
                  </button>
                )}
              </div>
            </div>
          </aside>
        </div>

        <section className={styles.editorSection} aria-labelledby="markdown-editor-title">
          <header className={styles.editorHeading}>
            <div>
              <p>03 / Manuscript</p>
              <h2 id="markdown-editor-title">Markdown 正文</h2>
            </div>
            <div className={styles.documentStats} aria-label="文章统计">
              <span><strong>{wordCount}</strong> 字词</span>
              <span><strong>{images.length}</strong> 附件</span>
            </div>
          </header>

          <div className={styles.editorControls}>
            <div className={styles.toolbar} role="toolbar" aria-label="Markdown 格式工具">
              <ToolbarButton label="二级标题" mark="H₂" onClick={() => prefixLines("## ")} />
              <ToolbarButton label="粗体" mark="B" shortcut="Ctrl/⌘ B" onClick={() => wrapSelection("**", "**", "粗体文本")} />
              <ToolbarButton label="斜体" mark="I" shortcut="Ctrl/⌘ I" onClick={() => wrapSelection("*", "*", "斜体文本")} />
              <ToolbarButton label="引用" mark="❞" onClick={() => prefixLines("> ")} />
              <ToolbarButton label="无序列表" mark="•—" onClick={() => prefixLines("- ")} />
              <ToolbarButton label="行内代码" mark="</>" onClick={() => wrapSelection("`", "`", "code")} />
              <span className={styles.toolbarDivider} aria-hidden="true" />
              <ToolbarButton label="插入链接" mark="链接" shortcut="Ctrl/⌘ K" onClick={openLinkEditor} />
              <ToolbarButton label="插入本地图片" mark="＋图片" onClick={openImagePicker} />
              <input
                ref={imageInputRef}
                className={styles.visuallyHidden}
                type="file"
                accept="image/jpeg,image/png,image/webp,image/gif,image/avif"
                multiple
                onChange={handleImageInput}
                tabIndex={-1}
              />
            </div>

            <div className={styles.viewSwitch} role="group" aria-label="编辑器视图">
              {(["write", "split", "preview"] as ViewMode[]).map((mode) => (
                <button
                  key={mode}
                  type="button"
                  className={viewMode === mode ? styles.activeView : undefined}
                  onClick={() => setViewMode(mode)}
                  aria-pressed={viewMode === mode}
                >
                  {mode === "write" ? "编辑" : mode === "split" ? "分栏" : "预览"}
                </button>
              ))}
            </div>
          </div>

          {linkOpen ? (
            <div
              className={styles.linkPanel}
              role="dialog"
              aria-label="插入链接"
              onKeyDown={(event) => {
                if (event.key === "Escape") {
                  event.stopPropagation();
                  closeLinkEditor();
                }
              }}
            >
              <label>
                <span>显示文字</span>
                <input value={linkText} onChange={(event) => setLinkText(event.target.value)} placeholder="链接文字" />
              </label>
              <label>
                <span>链接地址</span>
                <input
                  value={linkUrl}
                  onChange={(event) => {
                    setLinkUrl(event.target.value);
                    setLinkError("");
                  }}
                  placeholder="https://example.com 或 /posts"
                  autoFocus
                  aria-invalid={Boolean(linkError)}
                  aria-describedby={linkError ? "article-link-error" : undefined}
                  onKeyDown={(event) => {
                    if (event.key === "Enter") {
                      event.preventDefault();
                      event.stopPropagation();
                      insertLink();
                    }
                  }}
                />
              </label>
              <div className={styles.linkActions}>
                {linkError ? <small id="article-link-error">{linkError}</small> : <span />}
                <button type="button" onClick={closeLinkEditor}>取消</button>
                <button type="button" onClick={insertLink}>插入</button>
              </div>
            </div>
          ) : null}

          <div className={styles.workspace} data-view={viewMode}>
            <div className={styles.writePane}>
              <div className={styles.paneLabel}>
                <span>MARKDOWN.md</span>
                <small>可粘贴或拖入图片</small>
              </div>
              <label className={styles.visuallyHidden} htmlFor="article-content">Markdown 正文</label>
              <textarea
                ref={textareaRef}
                id="article-content"
                value={content}
                onChange={(event) => setContent(event.target.value)}
                onKeyDown={handleEditorKeyDown}
                onPaste={handleEditorPaste}
                onDrop={handleEditorDrop}
                placeholder={"# 从这里开始\n\n写下正文，或从工具栏插入链接和图片。"}
                spellCheck
                aria-invalid={
                  attempted &&
                  ((attemptedAction === "publish" && !content.trim()) ||
                    missingImageKeys.length > 0)
                }
                aria-describedby="article-content-hint"
              />
              <div className={styles.editorFoot} id="article-content-hint">
                <span>{content.length.toLocaleString()} 字符</span>
                <span>Tab 缩进 · Ctrl/⌘ S 保存草稿</span>
              </div>
            </div>

            <div className={styles.previewPane}>
              <div className={styles.paneLabel}>
                <span>实时预览</span>
                <small>{deferredContent !== content ? "正在排版…" : "GFM"}</small>
              </div>
              <div className={styles.previewScroller}>
                <ArticlePreview content={deferredContent} images={images} />
              </div>
            </div>
          </div>

          {images.length > 0 ? (
            <div className={styles.attachmentTray}>
              <div className={styles.trayHeading}>
                <div>
                  <strong>正文图片</strong>
                  <span>仅上传正文仍在引用的附件</span>
                </div>
                <span>{images.filter((image) => referencedKeys.has(image.key)).length} / {images.length} 已引用</span>
              </div>
              <div className={styles.attachmentList}>
                {images.map((image) => {
                  const used = referencedKeys.has(image.key);
                  return (
                    <article className={styles.attachment} key={image.key} data-used={used}>
                      <img src={image.previewUrl} alt="" />
                      <div>
                        <strong title={image.file.name}>{image.file.name}</strong>
                        <label>
                          <span>替代文字</span>
                          <input
                            value={image.alt}
                            onChange={(event) => updateImageAlt(image.key, event.target.value)}
                            maxLength={300}
                            placeholder="描述图片内容"
                          />
                        </label>
                      </div>
                      <div className={styles.attachmentActions}>
                        <span>{used ? "正文已引用" : "未引用"}</span>
                        {!used ? (
                          <button type="button" onClick={() => reinsertInlineImage(image)}>插入</button>
                        ) : null}
                        <button type="button" onClick={() => removeInlineImage(image.key)}>移除</button>
                      </div>
                    </article>
                  );
                })}
              </div>
            </div>
          ) : null}
        </section>

        <footer className={styles.actionBar}>
          <div className={styles.saveStatus} data-phase={phase} aria-live="polite">
            <span className={styles.statusDot} aria-hidden="true" />
            <div>
              <strong>{phase === "uploading" ? `${progress}%` : phase === "success" ? "已保存" : phase === "error" ? "需要处理" : "编辑中"}</strong>
              <p>{message}</p>
              {lastArticle?.published ? (
                <a href={lastArticle.url || `/posts/${lastArticle.slug}`}>
                  打开已发布文章 ↗
                </a>
              ) : null}
            </div>
          </div>

          {phase === "uploading" ? (
            <div
              className={styles.progressTrack}
              role="progressbar"
              aria-label="文章上传进度"
              aria-valuemin={0}
              aria-valuemax={100}
              aria-valuenow={progress}
            >
              <span style={{ width: `${progress}%` }} />
            </div>
          ) : null}

          <div className={styles.submitActions}>
            {phase === "uploading" ? (
              <button className={styles.cancelButton} type="button" onClick={cancelUpload}>取消上传</button>
            ) : null}
            {!lastArticle?.published ? (
              <button
                className={styles.draftButton}
                type="button"
                onClick={() => submitArticle(false)}
                disabled={phase === "uploading"}
                title="Ctrl/⌘ S"
              >
                {lastArticle ? "更新草稿" : "保存草稿"} <kbd>⌘S</kbd>
              </button>
            ) : null}
            <button
              className={styles.publishButton}
              type="submit"
              disabled={phase === "uploading"}
              title="Ctrl/⌘ Enter"
            >
              {lastArticle
                ? lastArticle.published
                  ? "更新已发布文章"
                  : "发布草稿"
                : "发布文章"} <kbd>⌘↵</kbd>
            </button>
          </div>
        </footer>
      </form>
    </main>
  );
}
