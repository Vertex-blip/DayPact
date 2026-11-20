export type AdminAccess =
  | { eligible: false }
  | { eligible: true; setupRequired: boolean; unlocked: boolean; expiresAt?: string };
export interface AdminSetup {
  secret: string;
  otpauthUri: string;
  expiresAt: string;
}
export type AdminAction = 'suspend' | 'restore' | 'delete';
export interface AdminUser {
  uid: string;
  email: string;
  displayName: string;
  emailVerified: boolean;
  disabled: boolean;
  createdAt: string | null;
  lastSignInAt: string | null;
  protected: boolean;
  appRegistered: boolean;
  moderation: 'active' | 'suspended' | 'delete_pending' | 'deleted';
}
export interface AdminPendingAction {
  uid: string;
  email: string;
  action: AdminAction;
  updatedAt: string;
}
export interface AdminUsers {
  users: AdminUser[];
  nextPageToken: string | null;
  pendingActions: AdminPendingAction[];
}
export interface SupportTicket {
  id: string;
  userId: string;
  category: 'help' | 'report';
  subject: string;
  message: string;
  status: 'open' | 'closed';
  reply: string;
  createdAt: string;
  updatedAt: string;
}
export interface AdminSupportTicket extends SupportTicket {
  email: string;
  displayName: string;
}
export interface AdminAudit {
  id: string;
  actorUid: string;
  targetUid: string | null;
  action: string;
  outcome: 'success' | 'failure';
  createdAt: string;
}
export interface AdminOverview {
  appUsers: number;
  newUsers7Days: number;
  suspendedUsers: number;
  openTickets: number;
  plans: number;
  databaseBytes: number;
  databaseLimitBytes: number;
  pushConfigured: boolean;
  accountManagementConfigured: boolean;
  push: { pending: number; delivered: number; skipped: number; failed: number };
  recentPushFailures: Array<{
    id: string;
    userId: string;
    kind: string;
    state: string;
    attempts: number;
    createdAt: string;
  }>;
}
