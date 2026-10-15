import Link from "next/link";

/** Returns from a detail page to its list. Sits in the left gutter on wide screens, above the content otherwise. */
export function BackLink({ href, label }: { href: string; label: string }) {
  return (
    <Link className="back-link" href={href} prefetch>
      <svg
        width="15"
        height="15"
        viewBox="0 0 24 24"
        fill="none"
        stroke="currentColor"
        strokeWidth="2.25"
        strokeLinecap="round"
        strokeLinejoin="round"
        aria-hidden="true"
      >
        <path d="M19 12H5M11 6l-6 6 6 6" />
      </svg>
      {label}
    </Link>
  );
}
