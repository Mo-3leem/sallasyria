import type { Metadata, Viewport } from "next";
import "./globals.css";

export const metadata: Metadata = {
  title: "سلة سوريا - أكبر منصة سورية للتجارة الإلكترونية",
  description: "أطلق متجرك الإلكتروني في دقائق. أنت تمتلك الرؤية، نحن نساعدك على بنائها.",
  keywords: ["سلة سوريا", "التجارة الإلكترونية", "متجر إلكتروني", "سوريا"],
  authors: [{ name: "Salla Syria" }],
  creator: "Salla Syria",
  publisher: "Salla Syria",
  formatDetection: {
    telephone: false,
  },
  metadataBase: new URL("https://sallasyria.com"),
  openGraph: {
    type: "website",
    locale: "ar_SY",
    url: "https://sallasyria.com",
    title: "سلة سوريا - أكبر منصة سورية للتجارة الإلكترونية",
    description: "أطلق متجرك الإلكتروني في دقائق. أنت تمتلك الرؤية، نحن نساعدك على بنائها.",
    siteName: "سلة سوريا",
  },
  twitter: {
    card: "summary_large_image",
    title: "سلة سوريا - أكبر منصة سورية للتجارة الإلكترونية",
    description: "أطلق متجرك الإلكتروني في دقائق.",
  },
  robots: {
    index: true,
    follow: true,
  },
};

export const viewport: Viewport = {
  themeColor: "#2E7D32",
  width: "device-width",
  initialScale: 1,
  maximumScale: 5,
};

export default function RootLayout({
  children,
}: {
  children: React.ReactNode;
}) {
  return (
    <html lang="ar" dir="rtl" className="scroll-smooth">
      <head>
        <link rel="preconnect" href="https://fonts.googleapis.com" />
        <link rel="preconnect" href="https://fonts.gstatic.com" crossOrigin="anonymous" />
        <link
          rel="stylesheet"
          href="https://cdn.jsdelivr.net/npm/@fortawesome/fontawesome-free@6.4.0/css/all.min.css"
        />
      </head>
      <body className="min-h-screen bg-white text-gray-900 antialiased">
        {children}
      </body>
    </html>
  );
}