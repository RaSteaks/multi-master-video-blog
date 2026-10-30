import type { Metadata } from "next";
import { StudioSignIn } from "@/components/StudioSignIn";
import { authorReturnPath } from "@/lib/author-navigation";

export const metadata: Metadata = { title: "登录", robots: { index: false, follow: false } };

export default async function Studio({ searchParams }: { searchParams: Promise<{ next?: string | string[] }> }) {
  const query = await searchParams;
  return <StudioSignIn next={authorReturnPath(query.next)} />;
}
