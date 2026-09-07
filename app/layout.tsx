import './globals.css';
import type { Metadata } from 'next';
import { ReactNode } from 'react';

export const metadata: Metadata = {
  title: 'Chess AI Hub · AlphaGo-Style Chess Assistant',
  description: 'Real-time AI analysis for Go, Xiangqi, and Chess. Win rate, move explanations, and top recommendations powered by Stockfish, Pikafish, and KataGo.',
};

export default function RootLayout({ children }: { children: ReactNode }) {
  return (
    <html lang="en">
      <body className="bg-black-deep text-silver-primary">
        {children}
      </body>
    </html>
  );
}