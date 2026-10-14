import { UploadPageClient } from "@/components/UploadPageClient";

export default async function UploadPage({ searchParams }: {
  searchParams: Promise<{ projectId?: string }>;
}) {
  const { projectId } = await searchParams;
  // Only an identifier travels in the link; protected project details are loaded after authentication.
  return <UploadPageClient initialProjectId={typeof projectId === "string" && /^[1-9]\d*$/.test(projectId) ? projectId : undefined} />;
}
