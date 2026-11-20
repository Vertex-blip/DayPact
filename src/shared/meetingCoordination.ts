/** Place and time polls apply to the whole meeting series. Other data is per occurrence. */
export interface MeetingTimeOption {
  id: string;
  date: string;
  time: string;
  availableUserIds: string[];
}
export type MeetingTravelStatus = 'on_way' | 'late' | 'arrived';
export interface MeetingTravel {
  uid: string;
  status: MeetingTravelStatus;
  lateMinutes: number | null;
  updatedAt: string;
}
export interface MeetingItem {
  id: string;
  title: string;
  createdBy: string;
  claimedBy: string | null;
  version: number;
}
export interface MeetingExpense {
  version: number;
  total: number;
  shares: { uid: string; displayName: string; amount: number; paid: boolean }[];
}
export interface MeetingCoordination {
  planVersion: number;
  date: string;
  minAttendees: number;
  acceptedCount: number;
  confirmed: boolean;
  timeOptions: { scope: 'series'; options: MeetingTimeOption[] };
  travel: MeetingTravel[];
  items: MeetingItem[];
  expense: MeetingExpense;
}
