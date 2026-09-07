import { GameClient } from '@/components/board/GameClient';
import { ErrorBoundary } from '@/components/ErrorBoundary';

export default function GoPage() {
  return (
    <ErrorBoundary>
      <GameClient
        variant="go"
        sides={['black', 'white'] as const}
        defaultSide="black"
        engine="KataGo v1.18.1 · Metal"
      />
    </ErrorBoundary>
  );
}