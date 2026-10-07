import { cronJobs } from 'convex/server';
import { internal } from './_generated/api';

const crons = cronJobs();

crons.interval('sweep orphan attachment uploads', { minutes: 30 }, internal.requestAttachments.sweepOrphans, {
  cursor: null,
});

export default crons;
