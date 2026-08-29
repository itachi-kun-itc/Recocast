import type { Metadata } from "next";
import "./globals.css";

export const metadata: Metadata = {
  metadataBase: new URL("https://itachi-kun-itc.github.io/Recocast/"),
  title: "Recocast — 雨雲アーカイブ",
  description: "雨雲レーダーのPNGを、観測日時とともに保存できるアーカイブ。",
  icons: { icon: "/Recocast/favicon.svg", shortcut: "/Recocast/favicon.svg" },
  openGraph: {
    title: "Recocast — 雨雲を、記録する。",
    description: "雨雲レーダーのPNGを観測日時とともに保存。",
    images: [{ url: "/Recocast/og.png", width: 1536, height: 1024 }],
  },
  twitter: {
    card: "summary_large_image",
    title: "Recocast — 雨雲を、記録する。",
    description: "雨雲レーダーのPNGを観測日時とともに保存。",
    images: ["/Recocast/og.png"],
  },
};

export default function RootLayout({ children }: Readonly<{ children: React.ReactNode }>) {
  return <html lang="ja"><body>{children}</body></html>;
}

