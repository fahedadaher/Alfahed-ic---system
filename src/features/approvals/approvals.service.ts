// =====================================================================
// Approvals service. Cashier and production approvals route to their
// respective server RPCs. Both are online-only.
// =====================================================================

import { syncEngine } from '../../lib/sync/sync-engine';
import { db } from '../../lib/db/indexeddb';
import type { ApprovalKind, ApprovalStatus } from '../../types/domain';

export const approvalsService = {
  async pending(kind: ApprovalKind) {
    return db.approvals
      .where('kind').equals(kind)
      .filter(a => a.status === 'pending')
      .reverse().sortBy('created_at');
  },

  async decide(args: {
    approvalId: string;
    kind: ApprovalKind;
    decision: Extract<ApprovalStatus, 'approved' | 'rejected'>;
    notes: string | null;
    userId: string;
  }): Promise<string> {
    const operation =
      args.kind === 'cashier' ? 'rpc:approve_cashier' : 'rpc:approve_production';
    return syncEngine.enqueue({
      operation,
      entity_type: 'approval',
      entity_id: args.approvalId,
      user_id: args.userId,
      payload: {
        approval_id: args.approvalId,
        decision: args.decision,
        notes: args.notes,
      },
    });
  },
};
