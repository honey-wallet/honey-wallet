import { thesisImage } from '@/lib/og/card';
import { loadLogos, loadThesis } from '@/lib/share';

export const alt = 'A thesis on Honey';
export const size = { width: 1200, height: 630 };
export const contentType = 'image/png';
export const revalidate = 300;

/** The same card as opengraph-image, for X (twitter:image). */
export default async function Image({ params }: { params: Promise<{ id: string }> }) {
  const { id } = await params;
  const [post, logos] = await Promise.all([loadThesis(id), loadLogos()]);
  return thesisImage(post, logos);
}
