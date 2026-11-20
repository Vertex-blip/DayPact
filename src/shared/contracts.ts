export type Locale = 'kk' | 'ru';
export type Theme = 'system' | 'dark' | 'light';
export interface Settings {
  locale: Locale;
  theme: Theme;
  notificationsEnabled: boolean;
  friendNudges: boolean;
  quietStart: string;
  quietEnd: string;
  timeZone: string;
}
export interface Profile {
  uid: string;
  displayName: string;
  username: string;
  bio: string;
  city: string;
  email: string;
  settings: Settings;
  createdAt: string;
}
export interface Friend {
  uid: string;
  displayName: string;
  username: string;
  city: string;
}
export interface Place {
  lat: number;
  lng: number;
  label: string;
}
export type Cadence = 'once' | 'daily' | 'weekly' | 'monthly';
export type PlanKind = 'habit' | 'event' | 'savings';
export interface PlanInput {
  title: string;
  description?: string;
  kind: PlanKind;
  cadence: Cadence;
  startDate: string;
  time: string;
  timeZone?: string;
  memberIds: string[];
  place?: Place | null;
  targetAmount?: number | null;
  remindMinutes: number;
}
export interface MemberProgress {
  uid: string;
  displayName: string;
  completed: boolean;
  contribution: number;
  rsvp: 'pending' | 'accepted' | 'declined';
  updatedAt: string | null;
}
export interface Plan extends PlanInput {
  id: string;
  ownerId: string;
  version: number;
  date: string;
  members: MemberProgress[];
  createdAt: string;
  updatedAt: string;
}
export interface MeetingPlaceOption {
  id: string;
  planId: string;
  proposedBy: string;
  proposerName: string;
  place: Place;
  voterIds: string[];
  createdAt: string;
}
export interface MeetingPlaces {
  planVersion: number;
  options: MeetingPlaceOption[];
}
export interface AppNotification {
  id: string;
  planId: string | null;
  kind: 'reminder' | 'nudge';
  title: string;
  body: string;
  read: boolean;
  createdAt: string;
}
export interface ApiErrorBody {
  error: { code: string; message: string; requestId?: string };
}
export interface Invitation {
  token: string;
  expiresAt: string;
}
export interface CheckinInput {
  date: string;
  completed: boolean;
  contribution?: number;
  operationId: string;
}
export interface MapManifest {
  id: string;
  city: string;
  url: string;
  bytes: number;
  sha256: string;
  bounds: [number, number, number, number];
  center: [number, number];
  minZoom: number;
  maxZoom: number;
  attribution: string;
  source: string;
  generatedAt: string;
}
export const DEFAULT_SETTINGS: Settings = {
  locale: 'kk',
  theme: 'dark',
  notificationsEnabled: true,
  friendNudges: true,
  quietStart: '22:00',
  quietEnd: '08:00',
  timeZone: 'Asia/Almaty',
};
