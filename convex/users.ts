import { query } from './_generated/server';
import { v } from 'convex/values';
import { authComponent } from './auth';

export const getViewer = query({
  args: {},
  returns: v.object({
    id: v.string(),
    email: v.string(),
    name: v.string(),
  }),
  handler: async (ctx) => {
    const user = await authComponent.getAuthUser(ctx);
    return {
      id: user._id,
      email: user.email,
      name: user.name,
    };
  },
});
