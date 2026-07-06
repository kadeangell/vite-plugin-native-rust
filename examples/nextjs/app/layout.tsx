import type { Metadata } from "next";
import type { ReactNode } from "react";

export const metadata: Metadata = {
  title: "vite-plugin-native-rust — Next.js example",
  description:
    "The same napi-rs crate the Vite plugin compiles, consumed directly from Next.js server code (Next.js does not run Vite plugins).",
};

export default function RootLayout({ children }: { children: ReactNode }) {
  return (
    <html lang="en">
      <body style={{ fontFamily: "ui-monospace, monospace", margin: "2rem" }}>
        {children}
      </body>
    </html>
  );
}
