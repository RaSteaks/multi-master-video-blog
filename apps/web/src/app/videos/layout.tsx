import { LiquidBackground } from "@/components/LiquidBackground";

/**
 * Video section layout — wraps all /videos/* routes with a purple-magenta
 * liquid flowing background.
 */
export default function VideosLayout({ children }: { children: React.ReactNode }) {
  return (
    <>
      <LiquidBackground variant="gray" />
      {children}
    </>
  );
}
