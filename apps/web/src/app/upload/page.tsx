import { UploadVideoForm } from "@/components/UploadVideoForm";

export default function UploadPage() {
  return (
    <main className="shell page-stack">
      <header className="page-header">
        <p className="eyebrow">Admin Upload</p>
        <h1>Upload Video</h1>
        <p className="summary">
          Upload a source master, package it as HLS, and publish the record to
          the video library.
        </p>
      </header>

      <UploadVideoForm />
    </main>
  );
}
