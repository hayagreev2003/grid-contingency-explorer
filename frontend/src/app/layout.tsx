import type { Metadata, Viewport } from 'next'
import './globals.css'

export const metadata: Metadata = {
  title: 'Grid Contingency Explorer',
  description:
    'Trip a transmission line and see which Indian cities lose supply — a graph-database demonstrator built on CognoDB.',
}

// The compact layout is a full-viewport map with sheets over it: it must not be
// laid out at a desktop width and scaled down. Pinch-zoom of the page itself is
// left available -- the map has its own, but the panel text should still be
// zoomable by anyone who needs it.
export const viewport: Viewport = {
  width: 'device-width',
  initialScale: 1,
  themeColor: '#0b0f14',
  interactiveWidget: 'resizes-content',
}

export default function RootLayout({ children }: { children: React.ReactNode }) {
  return (
    <html lang="en">
      <body>{children}</body>
    </html>
  )
}
