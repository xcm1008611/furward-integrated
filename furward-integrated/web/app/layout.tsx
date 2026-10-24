import type { Metadata } from "next";
import "./globals.css";

export const metadata: Metadata = {
  title: "绒途 Furward — 摸得到温暖，听得见方向",
  description: "绒途 Furward，一个有温度、会对话的 AI 导盲伙伴概念。探索出行引导、语音陪伴与触感设计。",
  icons: {
    icon: "/favicon.svg",
    shortcut: "/favicon.svg",
  },
};

export default function RootLayout({
  children,
}: Readonly<{
  children: React.ReactNode;
}>) {
  return (
    <html lang="zh-CN">
      <body className="antialiased">{children}</body>
    </html>
  );
}
