import type { Id } from '../convex/_generated/dataModel';
import type { Definition } from '../convex/definitionModel';

export function leaveDefinition(reviewerMembershipId: Id<'memberships'>): Definition {
  return {
    fields: [
      { type: 'date', key: 'startDate', label: { enUS: 'Start date', zhCN: '开始日期' }, required: true },
      { type: 'date', key: 'endDate', label: { enUS: 'End date', zhCN: '结束日期' }, required: true },
      {
        type: 'number',
        key: 'days',
        label: { enUS: 'Days', zhCN: '天数' },
        required: true,
        min: 1,
        max: 366,
        integer: true,
      },
      { type: 'text', key: 'reason', label: { enUS: 'Reason', zhCN: '原因' }, required: true, maxLength: 1000 },
    ],
    listColumns: ['startDate', 'endDate', 'days', 'reason'],
    dateRules: [{ startKey: 'startDate', endKey: 'endDate' }],
    policyPreset: 'requesterAndAssignedReviewer',
    reviewerMembershipId,
  };
}
