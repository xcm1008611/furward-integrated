import type { Metadata } from 'next';
import Experience from './Experience';

export const metadata: Metadata = {
  title: '城市引导体验 · 绒途 Furward',
  description: '和绒途一起，从西街口走到街心花园。体验路线引导、途中停步和文字交流。',
};

export default function ExperiencePage() {
  return <Experience />;
}
