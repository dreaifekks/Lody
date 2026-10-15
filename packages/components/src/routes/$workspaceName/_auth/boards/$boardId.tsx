import { createFileRoute } from '@tanstack/react-router';
export const Route = createFileRoute('/$workspaceName/_auth/boards/$boardId')({
  component: () => null,
});
