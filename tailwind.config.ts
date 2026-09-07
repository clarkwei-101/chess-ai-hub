import type { Config } from 'tailwindcss';

const config: Config = {
  content: ['./app/**/*.{ts,tsx}', './components/**/*.{ts,tsx}'],
  theme: {
    extend: {
      colors: {
        // Cyber Foundation 风格 - 黑银配色
        'black-deep': '#000000',
        'black-rich': '#0A0A0A',
        'black-surface': '#121212',
        'black-elevated': '#1A1A1A',
        'silver-primary': '#E8E8E8',
        'silver-mid': '#C0C0C0',
        'silver-dim': '#8A8A8A',
        'silver-dark': '#5A5A5A',
        'silver-border': '#2A2A2A',
        // 胜率专用 (绿→黄→红)
        'win-green': '#22C55E',
        'win-yellow': '#EAB308',
        'win-red': '#EF4444',
        'win-blue': '#3B82F6',
      },
      fontFamily: {
        sans: ['ui-sans-serif', 'system-ui', '-apple-system', 'Segoe UI', 'Helvetica Neue', 'sans-serif'],
        mono: ['ui-monospace', 'SFMono-Regular', 'Menlo', 'monospace'],
      },
      animation: {
        'pulse-glow': 'pulse-glow 2s ease-in-out infinite',
        'thinking': 'thinking 1.5s ease-in-out infinite',
      },
      keyframes: {
        'pulse-glow': {
          '0%, 100%': { opacity: '0.6', filter: 'drop-shadow(0 0 4px currentColor)' },
          '50%': { opacity: '1', filter: 'drop-shadow(0 0 12px currentColor)' },
        },
        'thinking': {
          '0%, 100%': { opacity: '0.4' },
          '50%': { opacity: '1' },
        },
      },
      boxShadow: {
        'glow-silver': '0 0 20px rgba(232, 232, 232, 0.3)',
        'glow-green': '0 0 20px rgba(34, 197, 94, 0.5)',
        'glow-red': '0 0 20px rgba(239, 68, 68, 0.5)',
      },
    },
  },
  plugins: [],
};

export default config;
