import type { Metadata } from "next";
import "./globals.css";
import "maplibre-gl/dist/maplibre-gl.css";

export const metadata: Metadata = {
  metadataBase: new URL("https://itachi-kun-itc.github.io/Recocast/"),
  title: "Recocast — 雨雲アーカイブ",
  description: "気象庁ナウキャストをリアルタイム表示し、直近3日と大雨時の雨雲の流れを保存するアーカイブ。",
  icons: { icon: "/Recocast/favicon.svg", shortcut: "/Recocast/favicon.svg" },
  openGraph: { title: "Recocast — 雨雲を、記録する。", description: "気象庁ナウキャストの直近3日と、大雨時の雨雲の流れを保存。", images: [{ url: "/Recocast/og.png", width: 1536, height: 1024 }] },
  twitter: { card: "summary_large_image", title: "Recocast — 雨雲を、記録する。", description: "気象庁ナウキャストの直近3日と、大雨時の雨雲の流れを保存。", images: ["/Recocast/og.png"] },
};

export default function RootLayout({ children }: Readonly<{ children: React.ReactNode }>) {
  return <html lang="ja"><body>{children}</body></html>;
}
