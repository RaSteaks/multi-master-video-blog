import { LiquidBackground } from "@/components/LiquidBackground";

/**
 * Blog section layout — wraps all /posts/* routes with a deep-blue
 * liquid flowing background.
 */
export default function PostsLayout({ children }: { children: React.ReactNode }) {
  return (
    <>
      <LiquidBackground variant="blue" />
      {children}
    </>
  );
}
