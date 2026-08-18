import type { Metadata } from 'next'
import './globals.css'

export const metadata: Metadata = {
  title: 'Grid Contingency Explorer',
  description:
    'Trip a transmission line and see which Indian cities lose supply — a graph-database demonstrator built on CognoDB.',
}

export default function RootLayout({ children }: { children: React.ReactNode }) {
  return (
    <html lang="en">
      <body>{children}</body>
    </html>
  )
}
