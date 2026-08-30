import { Geist } from "next/font/google";
import "./globals.css";
import { LanguageProvider } from "./components/LanguageProvider";
import { ThemeProvider } from "./components/ThemeProvider";
import BottomNav from "./components/BottomNav";
import { SITE_CONFIG } from "@/lib/constants";

// Runs before first paint to apply the persisted theme class to <html>, so the
// styled UI never flashes the wrong mode. Kept inline + synchronous; the html
// element also carries suppressHydrationWarning because React does not manage
// this class attribute (it is set here, pre-hydration).
const THEME_INIT_SCRIPT = `(function(){try{var t=localStorage.getItem('hotel_theme');if(t!=='light'&&t!=='dark'){t='dark';}var d=document.documentElement;if(t==='dark'){d.classList.add('dark');}else{d.classList.remove('dark');}}catch(e){document.documentElement.classList.add('dark');}})();`;

const geistSans = Geist({
  variable: "--font-geist-sans",
  subsets: ["latin"],
});

export const metadata = {
  title: SITE_CONFIG.name,
  description: SITE_CONFIG.description,
  appleWebApp: {
    capable: true,
    statusBarStyle: "default",
    title: SITE_CONFIG.shortName,
  },
};

export const viewport = {
  width: "device-width",
  initialScale: 1,
  maximumScale: 1,
  userScalable: false,
  viewportFit: "cover",
  themeColor: [
    { media: "(prefers-color-scheme: light)", color: "#F4F5F9" },
    { media: "(prefers-color-scheme: dark)", color: "#12131A" },
  ],
};

export default function RootLayout({ children }) {
  return (
    <html
      lang="am"
      className={`${geistSans.variable} h-full antialiased`}
      data-scroll-behavior="smooth"
      suppressHydrationWarning
    >
      <head>
        <script dangerouslySetInnerHTML={{ __html: THEME_INIT_SCRIPT }} />
      </head>
      <body className="bg-[var(--c-bg)] text-[var(--c-text)] antialiased min-h-screen selection:bg-[var(--c-accent)] selection:text-white dark:selection:text-white">
        <ThemeProvider>
          <LanguageProvider>
            {children}
            <BottomNav />
            {/* Phase 5: ServiceWorker disabled — offline POS state must not be served stale. See public/sw.js unregister handler. */}
          </LanguageProvider>
        </ThemeProvider>
      </body>
    </html>
  );
}
