import type { Metadata } from 'next';
import Assistance from './Assistance';

export const metadata: Metadata = {
  title: '无障碍引导 · 绒途 Furward',
  description: '为视障用户设计的绒途引导页：大按钮、语音播报、语音指令与高对比路线图。',
};

export default function AssistancePage() {
  return <Assistance />;
}
