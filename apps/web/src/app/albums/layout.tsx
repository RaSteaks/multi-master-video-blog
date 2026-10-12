import { LiquidBackground } from "@/components/LiquidBackground";

export default function AlbumsLayout({
  children,
}: {
  children: React.ReactNode;
}) {
  return (
    <>
      <LiquidBackground />
      {children}
    </>
  );
}
