import PublicSite from './PublicSite';
import { defaultContent } from '@/lib/content';
import { getContent } from '@/lib/cms-store';

export const dynamic = 'force-dynamic';

export default async function Home() {
  // Render saved content immediately, so custom images do not flash back to the demo.
  let content = defaultContent;
  try { content = (await getContent()).content; }
  catch { /* The client retries and shows a readable service notice on failure. */ }
  return <PublicSite initialContent={content} />;
}
