'use client';

import { Component, ReactNode } from 'react';

interface ErrorBoundaryProps {
  children: ReactNode;
  fallback?: (error: Error, reset: () => void) => ReactNode;
}

interface ErrorBoundaryState {
  error: Error | null;
}

/**
 * 通用 React 错误边界 — 捕获子组件抛出的错误,显示 fallback 而不是白屏。
 * 用于 wrap GameClient / Visual 等复杂组件,防止单个组件崩溃导致整页空白。
 */
export class ErrorBoundary extends Component<ErrorBoundaryProps, ErrorBoundaryState> {
  state: ErrorBoundaryState = { error: null };

  static getDerivedStateFromError(error: Error): ErrorBoundaryState {
    return { error };
  }

  componentDidCatch(error: Error, info: { componentStack?: string }) {
    // Log to console for debugging — production env can wire to Sentry/Datadog here
    console.error('ErrorBoundary caught:', error, info.componentStack);
  }

  reset = () => {
    this.setState({ error: null });
  };

  render() {
    const { error } = this.state;
    if (error) {
      if (this.props.fallback) return this.props.fallback(error, this.reset);
      return (
        <div className="min-h-screen bg-black-deep flex items-center justify-center p-8">
          <div className="glass rounded-2xl p-8 max-w-lg w-full text-center">
            <div className="w-12 h-12 mx-auto mb-4 rounded-full bg-red-500/15 border border-red-500/30 flex items-center justify-center">
              <svg width="20" height="20" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2" className="text-red-400">
                <circle cx="12" cy="12" r="10" />
                <line x1="12" y1="8" x2="12" y2="12" />
                <line x1="12" y1="16" x2="12.01" y2="16" />
              </svg>
            </div>
            <h2 className="text-silver-primary text-lg font-medium mb-2">Something went wrong</h2>
            <p className="text-silver-dim text-sm mb-4 break-all">{error.message}</p>
            <button
              onClick={this.reset}
              className="px-4 py-2 rounded-lg bg-silver-primary text-black-deep text-sm font-medium hover:bg-silver-light transition-colors"
            >
              Try Again
            </button>
          </div>
        </div>
      );
    }
    return this.props.children;
  }
}
