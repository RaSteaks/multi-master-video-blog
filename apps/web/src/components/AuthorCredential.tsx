"use client";

import type { ReactNode } from "react";
import { useAuthorSession } from "@/lib/author-session";

/** Shared status/override treatment; forms retain their original masked inputs. */
export function AuthorCredential({ children, scope = "upload", token = "" }: { children: ReactNode; scope?: "upload" | "article"; token?: string }) {
  const session = useAuthorSession();
  if (!session.author || (scope === "article" && !session.article)) return <>{children}</>;
  return <div className="author-credential">
    <p>{token.trim() ? "当前使用手动令牌" : "已作为作者登录"}</p>
    <details><summary>改用手动输入</summary>{children}</details>
  </div>;
}
