import type { Metadata } from 'next'
import AppNav from '@/app/components/AppNav'

export const metadata: Metadata = {
  title: 'AI Command Center',
  description: 'Routing requests, orchestrating work, enforcing approvals.',
}

export default function RootLayout({ children }: { children: React.ReactNode }) {
  return (
    <html lang="en">
      <body style={{ margin: 0, padding: 0 }}>
        <AppNav />
        {children}
      </body>
    </html>
  )
}
