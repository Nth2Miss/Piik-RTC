export interface Room {
  id: string;
  provider?: 'agora' | 'zego' | 'volc';
  name: string;
  description: string;
  inviteKey: string;
  isOwner: boolean;
  onlineCount: number;
  createdAt: number;
  updatedAt: number;
  closesAt: number | null;
}
export interface Participant { uid: number; name: string; sharing: boolean; isOwner: boolean }
