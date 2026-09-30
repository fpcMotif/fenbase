import { v } from 'convex/values';
import { mutation } from './_generated/server';
import { requireUser } from './auth';

export const seed = mutation({
  args: { locale: v.union(v.literal('en-US'), v.literal('zh-CN')) },
  returns: v.object({ collectionId: v.id('demoCollections') }),
  handler: async (ctx, { locale }) => {
    const ownerId = await requireUser(ctx);
    const name = 'sample_leads';
    const existing = await ctx.db
      .query('demoCollections')
      .withIndex('by_owner_name', (q) => q.eq('ownerId', ownerId).eq('name', name))
      .unique();
    if (existing) return { collectionId: existing._id };
    const collectionId = await ctx.db.insert('demoCollections', {
      ownerId,
      name,
      title: locale === 'zh-CN' ? '示例销售线索' : 'Sample leads',
      fields: [
        { name: 'company', type: 'text', required: true },
        { name: 'amount', type: 'number', required: true },
        { name: 'qualified', type: 'boolean', required: true },
      ],
    });
    for (const [company, amount] of [
      ['Aster Labs', 1200],
      ['Cedar Studio', 3400],
      ['Orchid Works', 2100],
    ] as const) {
      await ctx.db.insert('demoRecords', {
        ownerId,
        collectionId,
        values: { company, amount, qualified: false },
        updatedAt: Date.now(),
      });
    }
    await ctx.db.insert('demoWorkflows', {
      ownerId,
      collectionId,
      name: locale === 'zh-CN' ? '标记线索为合格' : 'Qualify sample leads',
      field: 'qualified',
      value: true,
    });
    return { collectionId };
  },
});
