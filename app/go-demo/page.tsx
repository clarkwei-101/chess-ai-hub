import { DemoGameClient } from '@/components/board/DemoGameClient';
import { ErrorBoundary } from '@/components/ErrorBoundary';

export default function GoDemoPage() {
  return (
    <ErrorBoundary>
      <DemoGameClient />
    </ErrorBoundary>
  );
}
