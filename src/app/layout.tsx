import "./globals.css";
import type { Metadata } from "next";
import { Inter, Source_Serif_4 } from "next/font/google";

const sans = Inter({ subsets: ["latin"], variable: "--font-sans", display: "swap" });
const serif = Source_Serif_4({ subsets: ["latin"], variable: "--font-serif", display: "swap", weight: ["400", "600", "700"] });

export const metadata: Metadata = {
  title: "Control Room",
  description: "Tenkara sourcing operations.",
};

export default function RootLayout({ children }: { children: React.ReactNode }) {
  return (
    <html lang="en" className={`${sans.variable} ${serif.variable}`}>
      <body className="min-h-screen bg-background text-foreground antialiased font-sans">{children}</body>
    </html>
  );
}
