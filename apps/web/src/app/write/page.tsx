import type { Metadata } from "next";
import { ArticleEditor } from "@/components/ArticleEditor";

export const metadata: Metadata = {
  title: "写文章",
  description: "在网站内编写、预览并发布 Markdown 文章。",
};

export default function WritePage() {
  return <ArticleEditor />;
}
