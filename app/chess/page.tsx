import { GameClient } from '@/components/board/GameClient';
import { ErrorBoundary } from '@/components/ErrorBoundary';

export default function ChessPage() {
  return (
    <ErrorBoundary>
      <GameClient
        variant="chess"
        sides={['white', 'black'] as const}
        defaultSide="white"
        engine="Stockfish 18 · SFNNv10"
      />
    </ErrorBoundary>
  );
}