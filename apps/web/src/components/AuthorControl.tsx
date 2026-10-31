"use client";

import dynamic from "next/dynamic";

// No author controls or device-specific markup enter cacheable server HTML.
export const AuthorControl = dynamic(
  () => import("./AuthorMenu").then(module => module.AuthorMenu),
  { ssr: false },
);
