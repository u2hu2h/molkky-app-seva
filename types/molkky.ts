// types/molkky.ts
import { Timestamp } from "firebase/firestore";

export interface Player {
  id: string;
  name: string;
  totalScore: number;      // 現セットのスコア
  totalSetScore: number;   // 複数セット用の累計得点
  missCount: number;
  isEliminated: boolean;
  turnOrder: number;
  setsWon: number;         // 勝利セット数（best of用）
}

export type GameStatus = "waiting" | "playing" | "finished";
export type GameMode = "single" | "multi" | "bestof";
export type OrderPattern = "fixed" | "reverse" | "slide";

export interface Game {
  id: string;
  createdAt: Timestamp;
  status: GameStatus;
  winScore: number;
  players: Player[];
  currentTurn: number;
  winnerId: string | null;
  // ゲームモード
  gameMode: GameMode;
  totalSets: number;
  bestOfSets: number;
  currentSet: number;
  orderPattern: OrderPattern;
  throwingTimeSec: number;   // 投擲タイマー秒数（0=無効）
  duceMode: boolean;         // Best Sets Match: Duceモード
  duceLeaderId: string | null; // Duce中：直前のセット勝者（連続取得チェック用）
}

export interface Turn {
  id: string;
  playerId: string;
  playerName: string;
  score: number;
  timestamp: Timestamp;
  scoreAfter: number;
  wasReset: boolean;
  setNumber: number;
}
