import { UploadPageClient } from "@/components/UploadPageClient";

export default async function UploadPage({ searchParams }: {
  searchParams: Promise<{ projectId?: string; session?: string }>;
}) {
  const { projectId, session } = await searchParams;
  // Only an identifier travels in the link; protected project details are loaded after authentication.
  return <UploadPageClient initialProjectId={typeof projectId === "string" && /^[1-9]\d*$/.test(projectId) ? projectId : undefined}
    initialSessionId={typeof session === "string" && /^[a-f0-9-]{36}$/i.test(session) ? session : undefined} />;
}
