import { notFound } from "next/navigation";
import {
  AlbumGallery,
  type GalleryAlbum,
} from "@/components/AlbumGallery";
import {
  albumPictureSources,
  assetUrl,
  getAlbum,
} from "@/lib/directus";
import { siteConfig } from "@/lib/site-config";

type AlbumPageProps = {
  params: Promise<{ slug: string }>;
};

export async function generateMetadata({ params }: AlbumPageProps) {
  const { slug } = await params;
  const album = await getAlbum(slug);
  if (!album) return {};
  const coverId = album.cover_image || album.photos?.[0]?.sdr_image || null;
  const cover = assetUrl(coverId, "album-cover");
  return {
    title: `${album.title} — ${siteConfig.title}`,
    description: album.description || `${album.title} 相簿`,
    openGraph: {
      title: album.title,
      description: album.description || undefined,
      type: "website" as const,
      images: cover ? [cover] : [],
    },
  };
}

export default async function AlbumPage({ params }: AlbumPageProps) {
  const { slug } = await params;
  const album = await getAlbum(slug);
  if (!album) notFound();

  const initialAlbum: GalleryAlbum = {
    id: album.id,
    title: album.title,
    slug: album.slug,
    description: album.description || "",
    coverImage: album.cover_image,
    published: true,
    photos: (album.photos ?? []).map((photo) => {
      const sources = albumPictureSources(photo);
      if (!sources.thumbnail || !sources.sdr) {
        throw new Error(`Album photo ${photo.id} is missing its required SDR file.`);
      }
      return {
        id: photo.id,
        sdrImage: photo.sdr_image!,
        hdrImage: photo.hdr_image,
        thumbnailUrl: sources.thumbnail,
        sdrUrl: sources.sdr,
        hdrUrl: sources.hdr,
        caption: photo.caption || "",
        altText: photo.alt_text || "",
        hdrTransfer: photo.hdr_transfer,
        hdrPrimaries: photo.hdr_primaries,
        hdrBitDepth: photo.hdr_bit_depth,
        published: true,
        sortOrder: photo.sort_order ?? 0,
      };
    }),
  };

  return <AlbumGallery initialAlbum={initialAlbum} />;
}
