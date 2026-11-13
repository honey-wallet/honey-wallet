import { jarImage } from '@/lib/og/card';
import { loadJar, loadLogos } from '@/lib/share';

export const alt = 'A jar on Honey';
export const size = { width: 1200, height: 630 };
export const contentType = 'image/png';
export const revalidate = 300;

/** The jar as its Feed card, for chats and X (lib/og/card.tsx). */
export default async function Image({ params }: { params: Promise<{ id: string }> }) {
  const { id } = await params;
  const [jar, logos] = await Promise.all([loadJar(id), loadLogos()]);
  return jarImage(jar, logos);
}
