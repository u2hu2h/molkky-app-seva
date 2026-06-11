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
  totalSets: number;       // multiの場合のセット数
  bestOfSets: number;      // bestofの場合の勝利セット数
  currentSet: number;      // 現在のセット番号
  orderPattern: OrderPattern; // 表示順パターン（multi/bestof用）
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
