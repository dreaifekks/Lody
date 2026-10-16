import { createFileRoute, Navigate } from '@tanstack/react-router';

export const Route = createFileRoute('/$workspaceName/_auth/boards/')({
  component: BoardsIndexRedirect,
});

function BoardsIndexRedirect() {
  const { workspaceName } = Route.useParams();
  return <Navigate to="/$workspaceName/chat" params={{ workspaceName }} replace />;
}
