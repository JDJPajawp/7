import './globals.css'
export const metadata = { title: 'Doscord Raider' }
export default function RootLayout({ children }: { children: React.ReactNode }) {
  return (
    <html lang="ja">
      <body className="min-h-screen bg-white dark:bg-gray-950 text-gray-900 dark:text-gray-100 p-6 flex flex-col items-center">
        {children}
      </body>
    </html>
  )
}
