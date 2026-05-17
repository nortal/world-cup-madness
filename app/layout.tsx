import './globals.css';
import type { Metadata } from 'next';

export const metadata: Metadata = {
  title: 'World Cup Madness',
  description: 'Internal Nortal prediction pool for FIFA World Cup 2026',
};

export default function RootLayout({
  children,
}: {
  children: React.ReactNode;
}) {
  return (
    <html lang="en">
      <body>{children}</body>
    </html>
  );
}
