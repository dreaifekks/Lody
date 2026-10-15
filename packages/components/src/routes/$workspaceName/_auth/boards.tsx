import { createFileRoute, useParams } from '@tanstack/react-router';
import { BoardsWorkspace } from '@/components/boards/boards-workspace';
export const Route = createFileRoute('/$workspaceName/_auth/boards')({ component: BoardsLayout });
function BoardsLayout() {
  const { boardId } = useParams({ strict: false }) as { boardId?: string };
  return <BoardsWorkspace boardId={boardId} />;
}
