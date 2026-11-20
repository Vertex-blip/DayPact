import type { SupportTicket } from '../../shared/admin';
export interface SupportRow {
  id: string;
  user_id: string;
  category: SupportTicket['category'];
  subject: string;
  message: string;
  status: SupportTicket['status'];
  reply: string;
  created_at: string;
  updated_at: string;
}
export const supportTicket = (row: SupportRow): SupportTicket => ({
  id: row.id,
  userId: row.user_id,
  category: row.category,
  subject: row.subject,
  message: row.message,
  status: row.status,
  reply: row.reply,
  createdAt: row.created_at,
  updatedAt: row.updated_at,
});
