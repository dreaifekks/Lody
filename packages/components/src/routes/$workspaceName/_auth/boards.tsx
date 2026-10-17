import { createFileRoute, Outlet } from '@tanstack/react-router';

/** Boards have no page of their own: the sidebar lists them, a Board opens as a conversation. */
export const Route = createFileRoute('/$workspaceName/_auth/boards')({ component: Outlet });
