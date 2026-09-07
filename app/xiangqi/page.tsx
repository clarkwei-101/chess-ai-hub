import { GameClient } from '@/components/board/GameClient';
import { ErrorBoundary } from '@/components/ErrorBoundary';

export default function XiangqiPage() {
  return (
    <ErrorBoundary>
      <GameClient
        variant="xiangqi"
        sides={['red', 'black'] as const}
        defaultSide="red"
        engine="Pikafish 2026-01-02"
      />
    </ErrorBoundary>
  );
}