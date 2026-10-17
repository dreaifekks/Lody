import { createFileRoute } from '@tanstack/react-router';
import { BoardRedirect } from '@/components/boards/board-redirect';

export const Route = createFileRoute('/$workspaceName/_auth/boards/$boardId')({
  component: BoardRoute,
});

function BoardRoute() {
  const { boardId } = Route.useParams();
  return <BoardRedirect boardId={boardId} />;
}
