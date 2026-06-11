"use client";

import { useState } from "react";
import { LiquidBackground } from "@/components/LiquidBackground";
import { UploadVideoForm } from "@/components/UploadVideoForm";

export type Lang = "en" | "zh";

const pageText = {
  en: {
    eyebrow: "Admin Upload",
    title: "Upload Video",
    summary:
      "Upload a source master, package it as HLS, and publish the record to the video library.",
  },
  zh: {
    eyebrow: "管理员上传",
    title: "上传视频",
    summary: "上传源母版，打包为 HLS，并将记录发布到视频库。",
  },
};

export function UploadPageClient() {
  const [lang, setLang] = useState<Lang>("zh");
  const text = pageText[lang];

  return (
    <>
      <LiquidBackground variant="teal" />
      <main className="shell page-stack upload-page">
      <div className="upload-page-intro">
        <header className="page-header upload-page-header">
          <p className="eyebrow">{text.eyebrow}</p>
          <h1>{text.title}</h1>
          <p className="summary">{text.summary}</p>
        </header>

        <div className="lang-switcher" role="group" aria-label="Language / 语言">
          <button
            className={lang === "zh" ? "active" : ""}
            onClick={() => setLang("zh")}
            aria-pressed={lang === "zh"}
          >
            中文
          </button>
          <button
            className={lang === "en" ? "active" : ""}
            onClick={() => setLang("en")}
            aria-pressed={lang === "en"}
          >
            English
          </button>
        </div>
      </div>

      <UploadVideoForm lang={lang} />
    </main>
    </>
  );
}
