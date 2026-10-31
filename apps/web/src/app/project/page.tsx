import type { Metadata } from "next";
import { ProjectGallery } from "@/components/ProjectGallery";
import { getExternalProjects } from "@/lib/directus";
import { siteConfig } from "@/lib/site-config";

export const metadata: Metadata = {
  title: `实验室 — ${siteConfig.title}`,
  description: "独立网页、工具与持续运行的视觉实验。",
};

export default async function ProjectPage({ searchParams }: {
  searchParams: Promise<{ dialog?: string | string[] }>;
}) {
  const query = await searchParams;
  const result = await getExternalProjects();
  return <main className="shell page-stack project-index">
    <ProjectGallery initial={result} createRequested={query.dialog === "create"} />
  </main>;
}
