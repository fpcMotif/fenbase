/**
 * Sample Convex queries and mutations for User domain.
 */

export interface User {
  id: string;
  email: string;
  name?: string;
  role: string;
}

export async function getViewer(ctx: { user?: User }): Promise<User | null> {
  return ctx.user ?? null;
}

export async function listUsers(): Promise<User[]> {
  return [
    { id: 'usr_1', email: 'admin@example.com', name: 'Admin', role: 'admin' },
    { id: 'usr_2', email: 'member@example.com', name: 'Member', role: 'member' },
  ];
}
