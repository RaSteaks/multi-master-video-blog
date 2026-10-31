"use client";

import { useRouter } from "next/navigation";
import { AuthorSignIn } from "./AuthorSignIn";

export function StudioSignIn({ next }: { next: string }) {
  const router = useRouter();
  return <AuthorSignIn onClose={() => router.replace("/")} onSuccess={() => router.replace(next)} />;
}
